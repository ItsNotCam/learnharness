# Learning tracks — a goal too big for one session

Shared understanding reached 2026-11-22 (owner + build session, from the approved
three-screen mockup). This is the convergence record — the decided design, with
reasoning. It is not a task list; the build order at the end is planned against it.
The owner ruled the first five questions directly and delegated the rest to the
build session's recommendations ("take your rec's from here on out", 2026-11-22);
every delegated ruling is marked so below.

---

## 1. What a track is

A **track** is a learning goal too big for one session. LearnHarness — never the
learner — splits it into **parts**, each part taught in its own teaching session
(plus optional practice sessions), the parts forming a dependency DAG (several
start nodes allowed; the learner picks which ready part to do next). After every
part ends, LH **re-plans the track automatically** and logs what changed. Every
part's propositions land in the one shared knowledge graph through the existing
extraction pipeline, exactly like any teaching session.

Every part carries the end goal, so each foundation arrives with a reason. Child
sessions know their place: the end goal, this part's goal and why, and what the
parts it builds on established.

Locked by the mockup approval ("perfect. lets get it built", 2026-11-21): LH
determines the parts; parts can split into sub-parts; teaching and practice
sessions nest under their part; the overview map shows parts, not propositions;
re-planning is automatic and logged.

## 2. Who decides a goal is a track — the prober (owner ruling 2026-11-22)

There is no "Track" door. The learner types the goal (or pastes a brief) into the
ordinary **+ TEACHING** composer. The **prober** decides: while concretizing the
goal it judges whether the goal spans more than one session's arc; if so it
switches to **placement probing** — a few questions per candidate part, at the
grain of whole sessions, enough to skip parts already held and order the rest —
and concludes with `propose_track` **instead of** `probe_done`. That session
becomes the track's **planning chat** (its placement probe, the proposal, every
revision and every later re-plan live there). Any teaching session can turn into
a track; a track part never can (the prober of a part chat has no
`propose_track`).

The construction seam mirrors `probe_done`: the first `propose_track` call in a
transcript means the chat is a planning chat — from that message on the handler
builds the **planner** agent for every turn in it (§4).

## 3. Data — an append-only event ledger (owner ruling 2026-11-22)

`data/tracks/tracks.jsonl` (`config.ts` `TRACKS_FILE`), one ledger for every
track, written only by the track service (`src/server/tracks.ts` through the
`TrackStore` port). Events, append order:

| event | payload |
|---|---|
| `created` | trackId, title, goal, brief (the learner's first message, verbatim), explanation, findings, leftOut, planningChatId, parts |
| `replanned` | trackId, afterPartId (null = learner-requested), note, parts (the FULL new list) |
| `part-started` | trackId, partId, chatId |
| `practice-attached` | trackId, partId, chatId |
| `renamed` | trackId, title |
| `deleted` | trackId (a tombstone; the fold drops the track) |

A part spec is `{ id, number, title, why, dependsOn[], parentPartId? }` — ids are
the planner's permanent slugs (plan_init's rule), `number` is assigned by the
system once and never changes ("1", "5", "5a"). Every re-plan keeps its full parts
list, so "what changed" is a real diff, never a lossy note.

**Derived, never stored.** `core/tracks.ts` folds the ledger into `TrackRecord`s
and derives the view at read time against the chat records:

- **done** — the part's teaching chat holds a clean `part_done` result; a split
  parent is done when every child is done.
- **in progress** — a teaching chat exists (and still exists on disk) with no
  `part_done`.
- **ready** — no teaching chat, every `dependsOn` part is done (a dependency on a
  split parent means all its children).
- **later** — otherwise.
- **split** — has children; never startable itself.

A deleted part chat makes its part ready/later again (self-healing, no cleanup).
Progress counts top-level parts ("3 OF 7 DONE"). The TRACK LOG is derived too:
created, each placement finding, part started, part done (from the chat's
`part_done` timestamp), re-planned (the note), practice attached.

## 4. Agents and tools

- **The prober** gains `propose_track` (planning chats only; absent in part chats)
  and, in part chats, `read_part`. Its new fragment `prober/20-tracks.md` carries
  the placement doctrine.
- **The planner** (`src/agent/prompts/planner/`, a new `PromptAgent`) runs every
  turn of a planning chat after the proposal: ask_user_question, the graph tools,
  research/pdf, the learner-file tools, `propose_track` (re-callable until the
  track starts — "Change something"), and after start `replan_track` +
  `read_part`. No quizzing, no teaching. It runs on the chat's own model (the
  conversation chain, like prober/teacher); no new model role exists.
- **The teacher** in a part chat gains `part_done` and `read_part`; the shared
  fragment `shared/35-track-parts.md` explains the `[Track context]` block, the
  citation link syntax (§7) and when `part_done` fires.

Tool contracts (schemas core-owned in `contracts/track.ts`, the probe_done law:
boundary-valid ⇔ consumer-parseable):

- `propose_track { title, goal, explanation, findings[{kind: held|low, text}], parts[{id, title, why, dependsOn}], leftOut? }` — refused while a question is open and once the track has started; validates slugs, dependencies and the DAG; the latest clean call is THE proposal (the planning chat is renamed to the proposed title). Nothing touches the ledger until the learner clicks **Start track**.
- `replan_track { afterPartId?, note, parts[{id, title, why, dependsOn, parentPartId?}] }` — the full replacement list (author-once, plan_init's protocol). Rules enforced server-side, error-back to the agent: started/done parts keep their ids and may not be dropped, split or re-parented; one level of splitting; `dependsOn` never names an ancestor; at least one leaf. Numbers are assigned by the system. Appends `replanned` even when nothing changed (the log says so).
- `part_done { summary, shaky? }` (owner ruling 2026-11-22: the teacher's tool is the ONLY done signal — no manual checkbox; the learner's lever is "Ask LH to re-plan") — refused while a question is open, once per chat. Its side effect queues the re-plan steer (§6). The summary is durable in the transcript as the call's arguments and feeds the re-plan and the next parts' context.
- `read_part { partId, offset? }` — a dependency part's teaching prose with message ids (`TEACHER [msg_…] …`), windowed by a token budget with a continuation offset.

## 5. Child sessions

**Start part** (overview panel, ready parts only) creates the part's teaching
chat: title = the part title, model stamped from the strong slot like every
newborn, and message[0] a **`track-context` marker** — the model-facing block
(end goal, the learner's brief, this part's goal and why, the parts it builds on
with their `part_done` summaries and ids, the later parts, the placement
findings, the instructions) with UI details for a collapsible card. LH opens the
session itself (delegated ruling): the route fires the first turn at once
(`continue` on the marker alone), and the learner lands on a session where the
prober is already asking from the context.

How a part's agents know what earlier parts taught (owner ruling 2026-11-22):
the context block's summaries, the existing graph tools (`list_propositions`
on the earlier chat id), and `read_part` on demand — never the full prose
injected up front.

**Practice** (delegated ruling): "Practice this part" on the part panel creates
a practice session attached to the part, opened with a track-context marker that
carries the part's summary and the propositions the graph has born in its
teaching chat; the practice agent poses from it. Practice sessions nest under
their part in the sidebar.

Part chats are ordinary teaching sessions otherwise: probe → plan → teach,
extraction, compaction, highlights — nothing changes. Planning chats are
EXCLUDED from extraction (their prose is logistics, not knowledge).

## 6. Re-planning — a turn in the planning chat (delegated ruling)

`part_done` delivers a **`track-replan` steer** (id `steer_track_<trackId>_<partId>`,
idempotent) to the planning chat through the same wake pipeline as the probe
handoff; the planner's turn reads the finished part's summary (and `read_part`
when it needs the passages), may split / add / drop / reorder parts, and calls
`replan_track` exactly once — also when nothing changes. The learner can read the
re-plan and argue in that chat. **Ask LH to re-plan** on the overview fires the
same steer with no `afterPartId` (logged "at your request") and opens the
planning chat.

## 7. The UI (the approved mockup, verbatim)

1. **Sidebar** — a track is a chat-list entry with a recursive expand/collapse:
   track → parts (→ sub-parts) → that part's teaching and practice sessions.
   Clicking a track or a part opens the overview (part pre-selected); a session
   row opens the chat. Loose chats keep listing as today; TEACHING / PRACTICE /
   ALL stays (PRACTICE shows practice sessions flat, attached ones included).
   Before the track starts, its planning chat shows as "TRACK · PROPOSED"; after
   start, the planning chat is the track node's first child row ("Planning") so
   it stays reachable — the one addition to the mockup. Status icons: done =
   check in circle, in progress = filled dot in the track accent, ready = open
   circle, later = dashed circle, track = waypoints glyph, session = chat bubble,
   practice = dumbbell. Expanded state persists per browser.
2. **Overview** `/track/<id>` — header (kicker TRACK, serif title, "N OF M DONE"
   pill, ASK LH TO RE-PLAN), the goal sentence, the TRACK MAP (dagre-laid DAG of
   parts styled by status with a legend; a split part is a dashed group holding
   its sub-parts), the SELECTED PART panel (kicker "PART N · STATUS", title, WHY
   THIS PART, BUILDS ON, SESSIONS linking to chats, the split note, a primary
   "Start part" / "Continue session" / "Open teaching session" or the locked
   "Unlocks when … is done.", and "Practice this part"), and the TRACK LOG.
   Live through the events channel (`tracks-changed`, turn events).
3. **Inside a part** — the breadcrumb above the title (TRACK NAME › PART N OF M ›
   TEACHING|PRACTICE), a TRACK button beside PLAN, a right rail with the track
   card (mini map marking HERE, OPEN TRACK →), this session's plan, and READY TO
   START IN THIS TRACK. **Taught-in chips** (owner ruling 2026-11-22: teacher-
   authored) — the teacher writes a link `part://<partId>/<messageId>` (ids come
   from `read_part`); the markdown renderer turns it into "TAUGHT IN PART 2 ·
   <title>" deep-linking to `/chat/<chatId>#message-<id>` (the existing message
   anchors).
4. **Proposal view** — the planning chat renders its transcript as the mockup
   once a proposal exists: kicker NEW TRACK, the proposed title, phase PLACEMENT;
   YOUR GOAL · PASTED BRIEF (first message, SHOW FULL BRIEF); LH's explanation;
   PLACEMENT PROBE (N questions · done, findings as ALREADY HELD / STARTS LOW,
   SHOW QUESTIONS reveals the answered cards); PROPOSED TRACK (mini DAG + the
   numbered list with each part's why and START / AFTER 1 / AFTER 2 AND 4;
   "LEFT OUT, PER YOUR BRIEF"); Start track / Change something; the composer
   reads "Ask LH to change the track…". After start the same page shows the
   track's re-plans and OPEN TRACK →. The question dock keeps working (the
   planner may ask).
5. **Graph** — `/?track=<id>` filters the canvas to nodes born in the track's
   sessions (a dismissible TRACK pill in the chrome); the overview links to it.

Visual language: the app's tokens; in-progress accent `--lh-track-accent` per
theme (amber in dark, goldenrod on paper, One Dark's yellow).

## 8. Deletion and rename (delegated rulings)

Deleting a track deletes its planning chat and every part and practice session
through the existing session-deletion choreography (409 while any of them has a
turn or job running; the same preserve-graph / delete-nodes choice applies to all
of them), then appends the tombstone. The dialog names the session count.
Renaming a track appends `renamed`. Deleting a single part chat from the sidebar
stays allowed — the part simply reads as not started again.

## 9. No backwards compatibility

The regime of `probe-teach-split.md` §8 holds: no compat shims, no migrations.
Records written before this feature have no track; nothing reads differently.
Test data gets wiped at pivots.

## 10. Build order

Each step lands on `feat/tracks` with tests for its pure core logic:

1. contracts + ledger + fold/derivation + API + sidebar tree + overview page;
2. the proposal flow (prober fragment, `propose_track`, the planner, the
   proposal view, Start track, Start part, the context marker);
3. the part chat's breadcrumb, TRACK button, rail; practice attachment;
4. `part_done`, the re-plan steer, `replan_track`, the log;
5. taught-in chips and the graph track filter.

Golden-fixture law (`tests/fixtures/golden-data/README.md`): the new marker kinds
(`track-context`, `track-replan`) join the EXPECTED coverage list only when real
records exist — after the owner's first live track, copy its planning chat and
one part chat in.

## 11. Deferred

Nested splits deeper than one level; a learner-side "mark done"; a track filter
on the chain table; automatic chips from graph provenance; per-track model
settings; exporting a whole track as markdown.
