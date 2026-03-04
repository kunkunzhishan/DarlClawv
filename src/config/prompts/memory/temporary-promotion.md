Classify temporary memory entries into personal vector memory and group vector memory.
Return strict JSON only with keys: personal_memories, group_memories.
Use concise durable statements; remove transient details.
personal_memories: useful for this same agent's future tasks.
group_memories: reusable cross-agent lessons (tool/process patterns).
Do not duplicate the same sentence in both arrays.
agent_id: {{agent_id}}
entries: {{entries_json}}
