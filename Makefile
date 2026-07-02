# x-osint — inference backend selector.
#
# Pick where Ollama runs, then launch the app against it:
#   make metal          app -> native host Ollama (Apple Metal GPU) — fast, macOS
#   make cpu            app -> bundled container Ollama (CPU) — portable
#   make gpu            app -> bundled container Ollama (NVIDIA GPU) — Linux + NVIDIA only
#
#   make native-ollama  one-time: install native Ollama + pull the models (macOS/Homebrew)
#   make down           stop everything
#   make logs           tail the app logs
#
# AI_MODEL / AI_SUMMARIZE_MODEL come from .env (Compose auto-loads it); default gemma3:4b.

COMPOSE = docker compose
# `down` must name every profile, otherwise a backend started under a different
# profile is left running when switching modes.
DOWN_ALL = $(COMPOSE) --profile cpu --profile gpu down --remove-orphans

.PHONY: metal cpu gpu native-ollama down logs help

metal: ## App uses native host Ollama (Apple Metal GPU). Run `make native-ollama` first.
	$(DOWN_ALL)
	OLLAMA_HOST=http://host.docker.internal:11434 $(COMPOSE) up -d --build

cpu: ## App uses the bundled container Ollama (CPU).
	$(DOWN_ALL)
	OLLAMA_HOST=http://ollama:11434 $(COMPOSE) --profile cpu up -d --build

gpu: ## App uses the bundled container Ollama (NVIDIA GPU; Linux hosts only).
	$(DOWN_ALL)
	OLLAMA_HOST=http://ollama-gpu:11434 $(COMPOSE) --profile gpu up -d --build

down: ## Stop and remove all containers.
	$(DOWN_ALL)

logs: ## Tail the app logs.
	$(COMPOSE) logs -f x-osint

native-ollama: ## One-time: install native Ollama (Homebrew) and pull both models.
	@command -v brew >/dev/null 2>&1 || { echo "Homebrew required: https://brew.sh"; exit 1; }
	@brew list ollama >/dev/null 2>&1 || brew install ollama
	@echo "Starting native Ollama bound to 0.0.0.0 so the app container can reach it..."
	@launchctl setenv OLLAMA_HOST 0.0.0.0:11434 2>/dev/null || true
	@brew services restart ollama
	@sleep 2
	@set -a; [ -f .env ] && . ./.env; set +a; \
	  OLLAMA_HOST=127.0.0.1:11434 ollama pull "$${AI_MODEL:-gemma3:1b}"; \
	  OLLAMA_HOST=127.0.0.1:11434 ollama pull "$${AI_SUMMARIZE_MODEL:-gemma3:4b}"
	@echo "Native Ollama ready. Launch the app with: make metal"

help: ## List targets.
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
