CREATE UNIQUE INDEX task_relation_pair_unique
ON task_relation (relation_type, least(source_task_id, target_task_id), greatest(source_task_id, target_task_id));
