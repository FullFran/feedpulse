# FeedPulse developer entry points.
#
# Every target is a thin wrapper around an npm script or a `docker compose`
# command. package.json and docker-compose.yml stay the single source of truth,
# so a contributor without `make` (Windows, a minimal container image) can run
# the underlying command directly and get exactly the same result.
#
# `make help` prints the target list. That listing is generated from the `## `
# comment on each target line, so a target without one is invisible: keep the
# comment on the same line as the target.

SHELL := /bin/sh
.DEFAULT_GOAL := help

# Overridable so a scratch stack can run next to the default one, for example:
#   make up COMPOSE_PROJECT=feedpulse-scratch POSTGRES_HOST_PORT=55433
NPM ?= npm
COMPOSE_PROJECT ?= feedpulse
COMPOSE ?= docker compose -p $(COMPOSE_PROJECT)

# Mirrors the POSTGRES_USER / POSTGRES_DB literals in docker-compose.yml.
POSTGRES_USER ?= postgres
POSTGRES_DB ?= rss_monitor

# Host-mode connection strings for the targets that run Node ON THE HOST
# (`migrate`, `dev`) against the containers `up-infra` starts.
#
# These MUST be passed explicitly and MUST NOT be taken from `.env`. `.env` is
# copied from `.env.example`, which is the deploy-oriented template: it points
# DATABASE_URL at the Compose-internal hostname `postgres`, which resolves
# inside the Compose network and nowhere else. A host process reading it fails
# to resolve the name before it opens a single connection. The container-mode
# services do not have this problem because docker-compose.yml overrides both
# URLs in their own `environment:` blocks.
#
# The ports mirror the defaults published in docker-compose.yml
# ("${POSTGRES_HOST_PORT:-55432}:5432" and "${REDIS_HOST_PORT:-56379}:6379");
# override POSTGRES_HOST_PORT / REDIS_HOST_PORT here and there together.
# The password is the literal docker-compose.yml hardcodes for the local
# postgres service, which is deliberately NOT the placeholder in `.env.example`.
POSTGRES_HOST_PORT ?= 55432
REDIS_HOST_PORT ?= 56379
HOST_DATABASE_URL ?= postgres://$(POSTGRES_USER):postgres@127.0.0.1:$(POSTGRES_HOST_PORT)/$(POSTGRES_DB)
HOST_REDIS_URL ?= redis://127.0.0.1:$(REDIS_HOST_PORT)
HOST_ENV := DATABASE_URL='$(HOST_DATABASE_URL)' REDIS_URL='$(HOST_REDIS_URL)'

# Host URL the dashboard is served from by `make dev`. PORT is read from `.env`
# by the API process itself, so override this too if you change it there.
DEV_URL ?= http://localhost:3000

.PHONY: help env install up up-infra down down-hard logs psql redis-cli \
	dev migrate seed screenshots lint typecheck test smoke bench

##@ General

help: ## List every target with its description
	@printf 'FeedPulse make targets\n'
	@awk 'BEGIN { FS = ":.*## " } \
		/^##@ / { printf "\n%s\n", substr($$0, 5); next } \
		/^[a-zA-Z0-9][a-zA-Z0-9_-]*:.*## / { printf "  %-12s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf '\nStart here: make dev\n'

##@ Setup

env: ## Create .env from .env.example, never overwriting an existing .env
	@if [ -f .env ]; then \
		echo ".env already exists; leaving it untouched."; \
	else \
		cp .env.example .env; \
		echo "Created .env from .env.example."; \
	fi

install: ## Install dependencies exactly as pinned in package-lock.json
	$(NPM) ci

##@ Local stack

up-infra: ## Start Postgres and Redis only, and wait until both report healthy
	$(COMPOSE) up -d --wait postgres redis

up: ## Build and start the full stack in Docker (infra + api + scheduler + worker)
	$(COMPOSE) up -d --build --wait

down: ## Stop the stack, keeping the Postgres volume
	$(COMPOSE) down --remove-orphans

down-hard: ## Stop the stack and delete its volumes (destroys local data)
	$(COMPOSE) down -v --remove-orphans

logs: ## Follow the logs of every service in the stack
	$(COMPOSE) logs -f --tail=100

psql: ## Open a psql shell on the stack's Postgres
	$(COMPOSE) exec postgres psql -U $(POSTGRES_USER) -d $(POSTGRES_DB)

redis-cli: ## Open a redis-cli shell on the stack's Redis
	$(COMPOSE) exec redis redis-cli

##@ Development

# Prerequisites are invoked as recursive `make` calls rather than declared as
# dependencies on purpose: `make -j` would otherwise be free to run migrations
# before Postgres is up.
#
# The three runtimes are backgrounded in one shell instead of requiring tmux or
# an extra dependency. Ctrl-C reaches all of them because the terminal signals
# the whole foreground process group; the trap is the safety net for the other
# case, where one runtime exits on its own and `wait` returns.
#
# `kill 0` (the whole process group) rather than `kill $pid`: `npm run` forks a
# shell that forks Node, so killing the npm process alone leaves the Node
# process it started running (verified). The group also contains `make` itself,
# so a teardown can print one `make: *** [dev] Terminated` line — the cost of
# not leaking three Node processes on every Ctrl-C.
dev: ## From a clean clone: .env, infra, migrations, then all three runtimes
	@$(MAKE) --no-print-directory env
	@$(MAKE) --no-print-directory up-infra
	@$(MAKE) --no-print-directory migrate
	@echo ""
	@echo "Starting api, scheduler and worker. Press Ctrl-C to stop all three."
	@echo "  Dashboard: $(DEV_URL)/dashboard/"
	@echo "  API docs:  $(DEV_URL)/docs"
	@echo "  Demo data: make seed (in a second terminal)"
	@echo ""
	@trap 'trap - INT TERM EXIT; kill 0' INT TERM EXIT; \
	$(HOST_ENV) $(NPM) run --silent start:api & \
	$(HOST_ENV) $(NPM) run --silent start:scheduler & \
	$(HOST_ENV) $(NPM) run --silent start:worker & \
	wait

migrate: ## Apply pending database migrations against the host-mode DATABASE_URL
	$(HOST_ENV) $(NPM) run migrate

seed: ## Load the demo dataset through the HTTP API (needs a running API)
	$(NPM) run demo:seed

screenshots: ## Recapture the dashboard screenshots in docs/assets
	$(NPM) run docs:screenshots

##@ Quality gates

lint: ## Run ESLint over the repository
	$(NPM) run lint

typecheck: ## Type-check the repository without emitting output
	$(NPM) run typecheck

test: ## Run the Jest suite
	$(NPM) test

smoke: ## Build a throwaway Docker stack, run the end-to-end smoke test, tear it down
	$(NPM) run smoke:ci

bench: ## Run the 100-feed capacity benchmark against a throwaway Docker stack
	$(NPM) run benchmark:stage:100:safe
