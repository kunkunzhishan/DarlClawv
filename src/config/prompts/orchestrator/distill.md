Classify temporary memory entries into personal and group memories.
Return strict JSON only. Do not include identity/self-naming statements.

[AGENT_ID]
{{agent_id}}

[ENTRIES]
{{entries_json}}

Rules:
- personal_memories: useful for this same agent's future tasks.
- group_memories: reusable cross-agent lessons.
- Use concise durable statements; remove transient details.
- Do not duplicate the same sentence in both arrays.

Return strict JSON with fields:
- personal_memories: array of strings
- group_memories: array of strings
