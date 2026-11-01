/**
 * bugs4 Step 27 (item 19): the context pack's `## User Request` section is the task
 * description, i.e. the current contents of `task.md`. The plan and the reviews say "check
 * `task.md`", and a round that does not know the section IS that file will report owner
 * evidence as missing while quoting it. The label sits on the line under the heading, so
 * anything that finds the heading by name keeps working.
 */
export const USER_REQUEST_SOURCE_LABEL_V1 =
  "_This section is the current contents of `task.md`, read at dispatch time. " +
  "Any instruction to check `task.md` (owner evidence, scope, decisions) refers to this section, " +
  "and where the plan describes what `task.md` currently says, this text is newer and wins._";
