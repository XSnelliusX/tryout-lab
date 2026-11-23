# Model comparison: build, test, and install the runtime files.
#
#   make install DEST=<dir>   build, then copy only the runtime files to <dir>:
#                               compare.mjs  parse_aa.mjs  aasync  web/
#   make install DEST=<dir> DRY_RUN=1   print what would happen, change nothing
#   make test                 Go tests, parser self-test, Node tests, web tests
#   make build                build bin/aasync and web/dist without installing
#
# Requirements: Go (see go.mod), Node >= 22 with npm. Runtime needs only Node.

DEST    ?=
DRY_RUN ?=
GO      ?= go
NPM     ?= npm
NODE    ?= node

WEB_SRC := $(shell find web/src web/public web/index.html web/vite.config.ts web/tsconfig.json web/package.json -type f 2>/dev/null)
GO_SRC  := $(shell find cmd internal -name '*.go' -not -name '*_test.go' 2>/dev/null) go.mod

.PHONY: all build install test test-go test-node test-web clean

all: build

bin/aasync: $(GO_SRC)
	@mkdir -p bin
	$(GO) build -trimpath -ldflags="-s -w" -o bin/aasync ./cmd/aasync

web/node_modules/.installed: web/package.json web/package-lock.json
	cd web && $(NPM) ci --no-audit --no-fund
	@touch web/node_modules/.installed

web/dist/index.html: web/node_modules/.installed $(WEB_SRC)
	cd web && $(NPM) run build

build: bin/aasync web/dist/index.html

install:
ifeq ($(strip $(DEST)),)
	$(error DEST is required, e.g. make install DEST=$$HOME/.config/opencode/model-comparison)
endif
ifeq ($(strip $(DRY_RUN)),1)
	@echo "[dry-run] would build bin/aasync and web/dist (if out of date)"
	@echo "[dry-run] would install into $(DEST):"
	@echo "[dry-run]   compare.mjs parse_aa.mjs aasync web/"
else
	@$(MAKE) --no-print-directory build
	@mkdir -p "$(DEST)"
	install -m 0644 compare.mjs "$(DEST)/compare.mjs"
	install -m 0644 server.mjs "$(DEST)/server.mjs"
	install -m 0644 parse_aa.mjs "$(DEST)/parse_aa.mjs"
	install -m 0755 bin/aasync "$(DEST)/aasync.tmp.$$$$" && mv -f "$(DEST)/aasync.tmp.$$$$" "$(DEST)/aasync"
	rm -rf "$(DEST)/web.new"
	cp -R web/dist "$(DEST)/web.new"
	rm -rf "$(DEST)/web"
	mv "$(DEST)/web.new" "$(DEST)/web"
	@echo "Installed model-comparison runtime into $(DEST)"
endif

test: test-go test-node test-web

test-go:
	$(GO) vet ./...
	$(GO) test ./...

test-node:
	$(NODE) parse_aa.mjs --offline --self-test
	$(NODE) --test test/

test-web: web/node_modules/.installed
	cd web && $(NPM) test

clean:
	rm -rf bin web/dist web/tsconfig.tsbuildinfo
