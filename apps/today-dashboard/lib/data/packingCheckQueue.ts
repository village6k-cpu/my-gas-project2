import type { Trade } from "../domain/types";
import { optimisticPackingCheck, type PackingCommand, type PackingManifest } from "../domain/packing";

type Intent = { id: string; checked: boolean; resolve: () => void; reject: (error: unknown) => void };
type Queue = { confirmed: PackingManifest; pending: Intent[]; failing: boolean; done?: Promise<void> };

/** 항목 클릭은 즉시 표시하고, 서버에는 확정 버전 기준으로 순서대로 보낸다. */
export function createPackingCheckQueue(io: {
  read: (id: string) => Trade | undefined;
  show: (id: string, packing: PackingManifest) => void;
  persist: (id: string, version: number, command: PackingCommand) => Promise<PackingManifest>;
  start: (id: string) => (error?: unknown) => void;
  recover: (id: string) => Promise<void>;
}) {
  const queues = new Map<string, Queue>();
  const commands = new Map<string, Promise<void>>();
  const overlay = (q: Queue) => {
    const desired = new Map(q.pending.map(i => [i.id, i.checked]));
    return { ...q.confirmed, entries: q.confirmed.entries.map(e => desired.has(e.id) ? { ...e, checked: desired.get(e.id)! } : e) };
  };
  async function drain(id: string, q: Queue, finish: (error?: unknown) => void) {
    let failure: unknown;
    try {
      while (q.pending.length) {
        const batch = [...q.pending];
        const desired = new Map(batch.map(i => [i.id, i.checked]));
        const entries = q.confirmed.entries.map(e => desired.has(e.id) ? { ...e, checked: desired.get(e.id)! } : e);
        q.confirmed = await io.persist(id, q.confirmed.version, { action: "save", entries, note: q.confirmed.note });
        q.pending.splice(0, batch.length);
        io.show(id, overlay(q));
        batch.forEach(i => i.resolve());
      }
    } catch (error) {
      failure = error;
      q.failing = true;
      io.show(id, q.confirmed);
      // 응답 유실·충돌은 재조회한다. 불확실한 요청을 자동 재전송하지 않는다.
      await io.recover(id).catch(() => {});
      q.pending.splice(0).forEach(i => i.reject(error));
    } finally {
      queues.delete(id);
      finish(failure);
    }
    if (failure) throw failure;
  }
  // 체크뿐 아니라 메모/교체/제외/확정도 같은 구성품 버전을 순서대로 사용한다.
  function command(id: string, run: () => Promise<void>): Promise<void> {
    const previous = commands.get(id);
    const execute = async () => { await queues.get(id)?.done; await run(); };
    const task = previous ? previous.then(execute) : execute();
    commands.set(id, task);
    const cleanup = () => { if (commands.get(id) === task) commands.delete(id); };
    void task.then(cleanup, cleanup);
    return task;
  }
  function checkNow(id: string, entryId: string, checked: boolean): Promise<void> {
    const trade = io.read(id);
    if (!trade?.packing) return Promise.reject(new Error("구성품을 먼저 불러와주세요"));
    const q = queues.get(id);
    if (q?.failing) return Promise.reject(new Error("저장 상태를 확인 중입니다"));
    const entries = trade.packing.entries.map(e => e.id === entryId ? { ...e, checked } : e);
    if (!entries.some(e => e.id === entryId) || !optimisticPackingCheck(trade, trade.packing.version, { action: "save", entries, note: trade.packing.note })) return Promise.reject(new Error("현재 구성품은 체크할 수 없습니다"));
    const queue: Queue = q ?? { confirmed: trade.packing, pending: [], failing: false };
    const promise = new Promise<void>((resolve, reject) => queue.pending.push({ id: entryId, checked, resolve, reject }));
    if (!q) queues.set(id, queue);
    io.show(id, overlay(queue));
    if (!q) {
      const finish = io.start(id);
      queue.done = drain(id, queue, finish);
      void queue.done.catch(() => {}); // 개별 체크/flush 호출자가 오류를 표시한다.
    }
    return promise;
  }
  return {
    pending: (id: string) => queues.has(id) || commands.has(id),
    flush: (id: string): Promise<void> => commands.get(id) ?? queues.get(id)?.done ?? Promise.resolve(),
    command,
    check: (id: string, entryId: string, checked: boolean): Promise<void> => commands.has(id)
      ? command(id, () => checkNow(id, entryId, checked)) : checkNow(id, entryId, checked),
  };
}
