-- A full-shop count belongs to the shop, not to the employee who started it.
-- Keep the authenticated actor on each new/edited observation for accountability,
-- while allowing another authenticated staff member (through the service API) to
-- continue, attach evidence, delete, or submit the same draft.
do $migration$
declare
  v_signature text;
  v_definition text;
  v_before text;
begin
  foreach v_signature in array array[
    'village.save_inventory_audit_observation(uuid,uuid,uuid,text,text,text,text,text,integer,integer,integer,integer,jsonb,text,text,timestamptz,timestamptz)',
    'village.delete_inventory_audit_observation(uuid,uuid,uuid,timestamptz)',
    'village.submit_inventory_audit(uuid,uuid,integer,integer)',
    'village.reserve_inventory_audit_evidence(uuid,uuid,uuid,uuid,text,integer)',
    'village.complete_inventory_audit_evidence(uuid,uuid,uuid,uuid)',
    'village.abort_inventory_audit_evidence(uuid,uuid,uuid,uuid)',
    'village.finalize_inventory_audit_evidence_abort(uuid,uuid,uuid,uuid)'
  ]
  loop
    select pg_get_functiondef(to_regprocedure(v_signature)::oid)
    into v_definition;

    if v_definition is null then
      raise exception 'inventory audit handoff migration did not find %', v_signature;
    end if;

    v_before := v_definition;
    v_definition := replace(
      v_definition,
      $guard$  if v_session.started_by <> p_actor_id then
    raise exception 'inventory audit session belongs to another user' using errcode = '42501';
  end if;
$guard$,
      ''
    );
    v_definition := replace(
      v_definition,
      $guard$    if v_existing.session_id <> p_session_id or v_existing.observed_by <> p_actor_id then
      raise exception 'inventory audit observation belongs to another session or user'
        using errcode = '42501';
    end if;
$guard$,
      $guard$    if v_existing.session_id <> p_session_id then
      raise exception 'inventory audit observation belongs to another session'
        using errcode = '42501';
    end if;
$guard$
    );
    v_definition := replace(
      v_definition,
      $guard$  if v_existing.session_id <> p_session_id or v_existing.observed_by <> p_actor_id then
    raise exception 'inventory audit observation belongs to another session or user'
      using errcode = '42501';
  end if;
$guard$,
      $guard$  if v_existing.session_id <> p_session_id then
    raise exception 'inventory audit observation belongs to another session'
      using errcode = '42501';
  end if;
$guard$
    );
    v_definition := replace(
      v_definition,
      $guard$  if v_observation.session_id <> p_session_id or v_observation.observed_by <> p_actor_id then
    raise exception 'inventory audit observation belongs to another session or user'
      using errcode = '42501';
  end if;
$guard$,
      $guard$  if v_observation.session_id <> p_session_id then
    raise exception 'inventory audit observation belongs to another session'
      using errcode = '42501';
  end if;
$guard$
    );

    if v_signature like 'village.save_inventory_audit_observation(%' then
      v_definition := replace(
        v_definition,
        $actor$          identification_status = p_identification_status,
          evidence_refs = v_existing.evidence_refs,
$actor$,
        $actor$          identification_status = p_identification_status,
          observed_by = p_actor_id,
          observed_by_email = btrim(p_actor_email),
          evidence_refs = v_existing.evidence_refs,
$actor$
      );
    end if;

    if v_definition = v_before then
      raise exception 'inventory audit handoff migration did not match guards for %', v_signature;
    end if;

    execute v_definition;
  end loop;
end;
$migration$;
