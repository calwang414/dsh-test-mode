---
name: plugin-testing
description: How to write and run dynamic Cordis plugin tests in test-mode mode.
metadata:
  modes:
    - test-mode
---

# Dynamic Cordis Plugin Testing (test-mode mode)

This skill is the loadable companion to the resident testing-workflow prompt section.
Use it when you need the exact suite JSON format or the three-phase assertion contract.

## Test targets

The tested object is a **dynamic Cordis plugin** — a plugin defined in-session through
`@pluginId` (or source under `test-mode/manifests/<name>/plugin.js`). A plugin is plain
JavaScript: a `function` or `{ apply(ctx) }` object that registers effects through the
context (`ctx.on`, `ctx.effect`, `ctx.provide`, registry disposers, injected timers).

## Three-phase contract

Every suite runs these phases in order:

1. **Pre-load snapshot** — record the baseline: the tool schemas visible in the test
   scope (`tools.schemas(scope)`), the existence of target events, and the existence
   of target services.
2. **Scenario assertions** — load the plugin under test into an isolated scope, then
   assert each entry:
   - `tool.visible`: a tool appears in `tools.schemas(scope)` with exact schema fields;
   - `event.responds`: attach a probe with `ctx.on`, trigger the event, assert the
     probe received the expected payload. This verifies the event reaches listeners
     in the scope and the payload round-trips — it does NOT prove the plugin itself
     registered a listener (a plugin listener is a black box a probe cannot
     distinguish from itself). To verify the plugin's business response to an event,
     compose assertions: trigger the event, then assert the plugin-exposed service
     state changed;
   - `service.provided`: `ctx.get(name)` exists and exposes the expected methods;
   - `tool.execute`: execute the tool with given args, assert result or error fields.
3. **Cleanup assertions** — dispose the loaded fiber, then assert the world is back to
   baseline: schemas return to the pre-load list and services are `undefined` again.
   Cleanup assertions are derived automatically from the scenario: every visible tool
   gets a `tool.gone` assertion and every provided service a `service.gone`. A failed
   cleanup assertion means a side-effect leak (a disposer not returned, a module-level
   singleton, a listener not removed). Event-listener removal is not asserted directly
   (it is a black box); verify event side effects by composing scenario assertions —
   trigger after disposal and assert the plugin-exposed service state did not change.

## Suite JSON format

```json
{
  "name": "example-plugin",
  "sourcePath": "test-mode/manifests/example/plugin.js",
  "scope": "test-mode-example",
  "assertions": [
    {
      "kind": "tool.visible",
      "tool": "example_greet",
      "expectSchema": { "description": "Greet a name", "properties": { "name": { "type": "string" } } }
    },
    {
      "kind": "event.responds",
      "event": "example/ping",
      "trigger": { "type": "emit", "payload": { "ok": true } },
      "expectPayload": { "ok": true }
    },
    {
      "kind": "service.provided",
      "service": "exampleGreeter",
      "expectMethods": ["greet"]
    },
    {
      "kind": "tool.execute",
      "tool": "example_greet",
      "args": { "name": "world" },
      "expectResult": { "greeting": "hello world" }
    }
  ]
}
```

## Running

- Run through the Test conversation view, or invoke the host JSON API
  (`POST /dsh-test-mode/api/run`) with `{ suite, workspaceId }`.
- Results land in `test-mode/results/<name>-<timestamp>.json`: one `phase` per phase,
  one `pass`/`fail` per assertion with the observed evidence.

## Writing plugin source for tests

- Plain JavaScript only (no TypeScript, JSX, or imports).
- Read optional services with `ctx.get(name)` and handle `undefined`.
- Every side effect must be reversible: keep disposers from `ctx.on`, `ctx.effect`,
  and registry `register()` calls, and return them from `ctx.effect()`.
- Timers come from the injected `timer` service (`ctx.timeout`, `ctx.interval`),
  never `setTimeout`.

# Test case management

Test cases live as JSON files under `test-mode/cases/<id>.json`, shared across
sessions. Case fields: `name`, `description`, `priority` (high/medium/low),
`preconditions`, `steps` (array of `{ action, expected }`), `tags`, `status`
(draft/active/archived), `createdAt`, `updatedAt`.

API: `GET/POST /dsh-test-mode/api/cases` and `GET/PUT/DELETE /dsh-test-mode/api/cases/:id`
(every request carries `workspaceId`). The model may read and write case files
directly; the Test view and the model share the same storage.

# API testing

## Projects, collections, requests

- A project is `test-mode/api/projects/<id>.json`: `{ name, baseUrl, collections }`.
- A collection is an entry in `collections`: `{ id, name, requests }`.
- A request has: `name`, `method`, `url` (relative to `baseUrl` or absolute),
  `headers`, `query`, `body`, `assertions`, `extract`.

## Environments and variables

- An environment is `test-mode/api/environments/<id>.json`: `{ name, variables }`.
- `{{VAR}}` placeholders in url/headers/query/body resolve from request-level
  `variables`, then environment variables.
- A request may declare `extract: [{ name, path }]`; the response JSON value at
  `path` is stored as a variable for later requests in the same collection run.

## Assertions

| type | operator | checks |
|---|---|---|
| `status` | eq/ne/gt/ge/lt/le | HTTP status code |
| `header` | contains/eq/regex | response header value |
| `body` | contains/eq/regex | response text |
| `json` | eq/ne/contains/regex | value at `$.a.b[0].c` path |
| `duration` | le | request duration in ms |

## Execution

- `POST /dsh-test-mode/api/run-request` — one request, with optional
  `environmentId` and `baseUrl`; writes one history entry.
- `POST /dsh-test-mode/api/run-collection` — runs every request of one collection
  sequentially (extracted variables flow between requests), writes a report to
  `test-mode/reports/<id>.json` and a history entry.
- `GET /dsh-test-mode/api/history` — recent executions (capped at 200).

# Execution reports

A report (`test-mode/reports/<id>.json`) contains `name`, `startedAt`,
`finishedAt`, `durationMs`, `summary` (`total`/`passed`/`failed`) and `results`
— one entry per request with `pass`, `status`, `durationMs`, per-assertion
outcomes, and the error when any assertion failed. Reports are generated by
collection runs; the Report conversation view lists and renders them. When the
model reports execution results, cite the summary and the failing assertion
evidence.
