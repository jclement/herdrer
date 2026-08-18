package agentskill

import "strings"

// Render returns the skill document with the deployment's own origin baked in.
//
// This text is the single source for both /onboard/skill.md and the copy
// written to disk for the agents on this box, so the instructions an agent
// reads can never describe a different API than the one answering it.
func Render(origin string) string {
	return strings.ReplaceAll(skillTemplate, "{{ORIGIN}}", strings.TrimRight(origin, "/"))
}

const skillTemplate = "---\n" +
	"name: herdrer\n" +
	"description: Ask Jeff a question, or put a finished change in front of him, when you are " +
	"blocked on a judgement call he has to make. Use when a decision is irreversible, when two " +
	"reasonable approaches diverge, or when work is done and needs eyes before it lands. Do not " +
	"use for anything you could have inferred from the ticket, the code, or the conventions.\n" +
	"---\n\n" +
	"# herdrer — asking the human\n\n" +
	"`{{ORIGIN}}` is a review inbox on Jeff's phone. You post a document; he taps an answer; your\n" +
	"blocking call returns.\n\n" +
	"## The economics, which are the whole point\n\n" +
	"You are fast, cheap and always awake. He is none of those. p50 latency on this endpoint is\n" +
	"minutes; p99 is overnight. Every call spends a scarce resource, and the scarce resource is\n" +
	"his **attention**, not his tapping.\n\n" +
	"So: **ask rarely, and ask well.** A question that could have been answered by reading the\n" +
	"work item, the surrounding code, or the project conventions is a wasted call. If you are\n" +
	"about to ask which of two equivalent names to use, pick one.\n\n" +
	"Ask when:\n\n" +
	"- the action is **irreversible** — a migration that drops data, a force push, anything\n" +
	"  customer-visible\n" +
	"- two approaches genuinely diverge on a **judgement** axis you cannot resolve: cost, risk\n" +
	"  appetite, which customer will scream\n" +
	"- the work is **done** and wants review before it lands\n" +
	"- you found something **alarming** that is outside the task you were given\n\n" +
	"## Setup\n\n" +
	"```sh\n" +
	"export HERDRER_URL={{ORIGIN}}\n" +
	"export HERDRER_TOKEN=sk_...   # minted in Settings -> Agent tokens\n" +
	"```\n\n" +
	"## Ask, and block until answered\n\n" +
	"```sh\n" +
	"ID=$(curl -sS -X POST \"$HERDRER_URL/api/v1/agent/review\" \\\n" +
	"  -H \"Authorization: Bearer $HERDRER_TOKEN\" -H 'Content-Type: application/json' \\\n" +
	"  -d '{\n" +
	"    \"title\": \"Nullable column + backfill, or required with a default?\",\n" +
	"    \"kind\": \"choice\",\n" +
	"    \"body_md\": \"## What is happening\\n...\",\n" +
	"    \"options\": [\n" +
	"      {\"key\":\"A\",\"label\":\"Nullable + backfill\",\"detail\":\"Two deploys. Reversible. Slower.\"},\n" +
	"      {\"key\":\"B\",\"label\":\"Required with a default\",\"detail\":\"One deploy. Locks big tenants.\"}\n" +
	"    ],\n" +
	"    \"recommend\": \"A\",\n" +
	"    \"attachments\": [{\"kind\":\"diff\",\"title\":\"migration\",\"content\":\"--- a/...\"}],\n" +
	"    \"context\": {\"repo\":\"be\",\"branch\":\"feature/2134_export\",\"worker\":\"be-2134\"},\n" +
	"    \"urgency\": \"blocking\",\n" +
	"    \"expires_in_hours\": 12\n" +
	"  }' | jq -r .data.id)\n\n" +
	"# Blocks. Re-issue until it returns something other than \"open\".\n" +
	"while :; do\n" +
	"  R=$(curl -sS \"$HERDRER_URL/api/v1/agent/review/$ID?wait=300\" \\\n" +
	"        -H \"Authorization: Bearer $HERDRER_TOKEN\")\n" +
	"  S=$(echo \"$R\" | jq -r .data.status)\n" +
	"  [ \"$S\" = open ] || break\n" +
	"done\n" +
	"echo \"$R\" | jq '.data | {status, answer_value, answer_note}'\n" +
	"```\n\n" +
	"## Rules that are not negotiable\n\n" +
	"**`recommend` is required** for `choice` and `confirm`, and the API refuses the request\n" +
	"without it. Presenting options with no opinion offloads the thinking onto the expensive\n" +
	"model. Say what you would do and why, then let him overrule you.\n\n" +
	"**An expired item is not a yes.** `status: \"expired\"` means nobody was looking. It is not\n" +
	"consent, not \"go with the recommendation\", not \"proceed carefully\". The response for an\n" +
	"expired item does not even include your recommendation, so you cannot accidentally read it\n" +
	"back out. Report that it expired, and stop.\n\n" +
	"**`answer_note` outranks `answer_value`.** If he tapped B and wrote \"B, but rename the\n" +
	"column first\", the answer is not B. Read the note every time; act on it.\n\n" +
	"**Cancel what you abandon.** `DELETE /api/v1/agent/review/{id}` when the worker dies or the\n" +
	"question goes stale. An inbox full of questions nobody needs answered any more is how this\n" +
	"stops being useful.\n\n" +
	"## Writing a document worth reading\n\n" +
	"He is reading this on a phone, probably while doing something else. Lead with the decision.\n\n" +
	"- **Title**: the actual question, not a topic. \"Drop the legacy column?\" beats \"Migration\".\n" +
	"- **First paragraph**: what happens if he picks each option. Consequences, not background.\n" +
	"- **`detail` on each option**: the trade-off in one line — cost, reversibility, blast radius.\n" +
	"- **Attach the real diff.** `{\"kind\":\"diff\"}`, not a description of a diff. Trim it to the\n" +
	"  hunks that matter; a 300-line diff on a phone is a defer, not a decision.\n" +
	"- **A mermaid diagram** (`{\"kind\":\"mermaid\"}`) when the shape of the thing is the question.\n" +
	"- **Argue against yourself once.** The strongest reason not to do what you recommend.\n\n" +
	"## Picking up work he queued\n\n" +
	"```sh\n" +
	"curl -sS \"$HERDRER_URL/api/v1/agent/tasks/claim\" -H \"Authorization: Bearer $HERDRER_TOKEN\"\n" +
	"```\n\n" +
	"Claiming is atomic, so two idle agents cannot take the same task. A task is a human\n" +
	"instruction typed on a phone — treat it as a starting point to think about, not a\n" +
	"specification to execute literally, and ask if it is ambiguous.\n\n" +
	"## What this token cannot do\n\n" +
	"Your token can submit review items and read the answers to its own. It cannot open a\n" +
	"terminal, read another agent's items, mint another token, or see the audit log. That is\n" +
	"deliberate and there is no flag to change it — if you think you need shell access, you need\n" +
	"to ask a human for it out of band.\n"
