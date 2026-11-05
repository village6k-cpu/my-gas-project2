import type { PackingCommand, PackingEntry, PackingManifest } from "../domain/packing";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const conflict = () => new Error("같은 구성품을 다른 작업에서 변경했습니다. 입력한 내용과 최신 내역을 확인해주세요");

/** 기다리는 동안 확정된 체크/메모를 옛 전체 목록으로 덮지 않고 이번 입력의 차이만 합친다. */
export function rebasePackingCommand(command: PackingCommand, base: PackingManifest | undefined, latest: PackingManifest | undefined): PackingCommand {
  if (!base || !latest || base.version === latest.version) return command;
  if (base.phase !== latest.phase) throw conflict();
  if (command.action === "receive") {
    if (!same(base.counts[command.partId], latest.counts[command.partId]) && !same(command.count, latest.counts[command.partId])) throw conflict();
    return command;
  }
  if (command.action === "model") {
    if (base.deviceModels?.[command.ownerId] !== latest.deviceModels?.[command.ownerId] && command.model !== latest.deviceModels?.[command.ownerId]) throw conflict();
    return command;
  }
  if (command.action !== "save") return command;
  const original = new Map(base.entries.map(e => [e.id, e]));
  const desired = new Map(command.entries.map(e => [e.id, e]));
  const current = new Map(latest.entries.map(e => [e.id, e]));
  for (const [id, before] of original) {
    const next = desired.get(id), now = current.get(id);
    if (!next) {
      if (now && !same(before, now)) throw conflict();
      current.delete(id);
    } else if (!same(before, next)) {
      if (!now) throw conflict();
      const merged = { ...now } as unknown as Record<string, unknown>;
      for (const key of new Set([...Object.keys(before), ...Object.keys(next)])) {
        const field = key as keyof PackingEntry;
        if (same(before[field], next[field])) continue;
        if (!same(before[field], now[field]) && !same(next[field], now[field])) throw conflict();
        merged[key] = next[field];
      }
      current.set(id, merged as unknown as PackingEntry);
    }
  }
  for (const [id, entry] of desired) {
    if (original.has(id)) continue;
    if (current.has(id) && !same(current.get(id), entry)) throw conflict();
    current.set(id, entry);
  }
  if (command.note !== base.note && latest.note !== base.note && command.note !== latest.note) throw conflict();
  return { ...command, entries: [...current.values()], note: command.note === base.note ? latest.note : command.note };
}
