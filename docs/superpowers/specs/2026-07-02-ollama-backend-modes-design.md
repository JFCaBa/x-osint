# Selectable Ollama backend: metal / cpu / gpu

**Date:** 2026-07-02
**Status:** Approved (pending spec review)

## Problem

Ollama currently runs only as a bundled container. On macOS, Docker (OrbStack) runs a
Linux VM with no GPU passthrough, so inference is CPU-only and slow (the source of the
"stuck queue" earlier). The Mac's Apple Metal GPU is only usable by a **native** Ollama
running on the host. We want to pick the inference backend at launch:

- **metal** — native host Ollama using the Apple Metal GPU (fast; this Mac's real fix).
- **cpu** — bundled container Ollama, CPU-only (portable default; works anywhere).
- **gpu** — bundled container Ollama with NVIDIA passthrough (for a Linux + NVIDIA host;
  kept for portability — it will NOT function on this M4 Mac).

## Goal

A single launch parameter (a `Makefile` target) that selects `metal | cpu | gpu`, wiring
the app's `OLLAMA_HOST` and starting only the right Ollama backend, plus a one-time
`native-ollama` setup that installs and runs native Ollama with both models.

## Scope decisions (from brainstorming)

- Selector is a `Makefile` (single knob per mode); raw `docker compose --profile …`
  remains usable underneath.
- Keep the `gpu` profile even though it can't run on this Mac (portability). Document that
  it needs a Linux host with an NVIDIA GPU + container toolkit.
- `.env` `AI_MODEL=gemma3:1b` applies across all modes (unchanged).

## Architecture

### docker-compose.yml

- `x-osint`: `OLLAMA_HOST: ${OLLAMA_HOST:-http://ollama:11434}`; remove the hard
  `depends_on: ollama` so `metal` can run the app alone. (Ordering for cpu/gpu is handled
  by the pull services and Ollama's own readiness; the app already tolerates an
  unreachable Ollama via retries/fallbacks.)
- `ollama` + `ollama-pull` → add `profiles: ["cpu"]` (otherwise unchanged; still pull both
  `$AI_MODEL` and `$AI_SUMMARIZE_MODEL` via the `$$`-escaped entrypoint).
- New `ollama-gpu` + `ollama-pull-gpu` → `profiles: ["gpu"]`, identical to the cpu pair
  except the server reserves the NVIDIA GPU:
  ```yaml
  ollama-gpu:
    image: ollama/ollama:latest
    profiles: ["gpu"]
    ports: ["11434:11434"]
    volumes: ["ollama-models:/root/.ollama"]
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: ["gpu"]
    restart: unless-stopped
  ```
  `ollama-pull-gpu` mirrors `ollama-pull` but `depends_on: ollama-gpu`. Both container
  backends share the `ollama-models` volume so pulled models persist across cpu/gpu.

Only one backend runs at a time (selected by profile / metal runs none), so there is no
host-port-11434 clash.

### Makefile

Targets set `OLLAMA_HOST` + the compose profile together and start cleanly (each brings
the stack down first so switching modes never leaves a stale backend):

```makefile
COMPOSE = docker compose

metal:            ## App uses native host Ollama (Apple Metal GPU)
	$(COMPOSE) down
	OLLAMA_HOST=http://host.docker.internal:11434 $(COMPOSE) up -d --build

cpu:              ## App uses the bundled container Ollama (CPU)
	$(COMPOSE) down
	OLLAMA_HOST=http://ollama:11434 $(COMPOSE) --profile cpu up -d --build

gpu:              ## App uses the bundled container Ollama (NVIDIA GPU; Linux hosts only)
	$(COMPOSE) down
	OLLAMA_HOST=http://ollama-gpu:11434 $(COMPOSE) --profile gpu up -d --build

down:             ## Stop everything
	$(COMPOSE) --profile cpu --profile gpu down

logs:             ## Tail the app
	$(COMPOSE) logs -f x-osint

native-ollama:    ## One-time: install native Ollama + pull models (macOS/Homebrew)
	brew list ollama >/dev/null 2>&1 || brew install ollama
	brew services restart ollama
	OLLAMA_HOST=127.0.0.1:11434 ollama pull $${AI_MODEL:-gemma3:1b}
	OLLAMA_HOST=127.0.0.1:11434 ollama pull $${AI_SUMMARIZE_MODEL:-gemma3:4b}
```

`.PHONY` for all targets. `$$` escapes the shell var so `make` passes it through.

### Native Ollama reachability

Native Ollama must be reachable from the app container via `host.docker.internal`. On
OrbStack, `host.docker.internal` maps to the host and can reach host services. Default
Ollama binds `127.0.0.1:11434`. Implementation verifies reachability from a container; if
the loopback bind is not reachable, native Ollama is set to listen on all interfaces
(`OLLAMA_HOST=0.0.0.0:11434` in its launch environment) — the concrete mechanism (a
`launchctl setenv` before `brew services`, or a launch-agent env) is settled during
implementation and confirmed by a live probe. Security note: binding `0.0.0.0` exposes
Ollama on the local network; acceptable for a personal laptop.

## Verification (per mode, live)

- `make native-ollama` → `ollama list` on the host shows `gemma3:1b` + `gemma3:4b`;
  `ollama ps` during a request shows Metal GPU use (non-zero VRAM), and a host inference
  is fast (seconds, not minutes).
- `make metal` → only `x-osint` container runs; `/api/ai/status` → `ready:true`; a
  reclassify drains the AI queue quickly (Metal-fast).
- `make cpu` → `ollama` + `ollama-pull` containers run; app reaches `http://ollama:11434`;
  `/api/ai/status` ready.
- `make gpu` → `docker compose config` renders the NVIDIA device reservation and profile
  wiring correctly (functional runtime check only on a Linux + NVIDIA host — documented,
  not run here).
- README/docs: a short "Choosing an inference backend" section listing the three `make`
  targets and the `native-ollama` prerequisite for `metal`.

## Out of scope

- Auto-detecting the best backend.
- Changing which models are used (still `AI_MODEL` / `AI_SUMMARIZE_MODEL`).
- Non-Ollama providers; a UI to switch backends.
- Making `gpu` actually run on macOS (not possible).

## Execution note

This is docker-compose + a Makefile + host setup — no unit-testable application code. After
spec approval it is implemented directly with the live per-mode verification above, not via
the subagent test pipeline used for code changes.
