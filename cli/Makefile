# llama-cli — build / test / cross-compile
BINARY  := llama-cli
PKG     := ./...
VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)
DIST    := dist

.PHONY: all build test vet fmt lint install clean dist

all: fmt vet test build

build:
	go build -ldflags "$(LDFLAGS)" -o $(BINARY) .

test:
	go test $(PKG)

vet:
	go vet $(PKG)

fmt:
	gofmt -w .

# gofmt check for CI (fails if anything is unformatted).
lint:
	@test -z "$$(gofmt -l .)" || (echo "unformatted files:"; gofmt -l .; exit 1)

install:
	go install -ldflags "$(LDFLAGS)" .

# Cross-compile release binaries for the common desktop targets.
dist: clean
	@mkdir -p $(DIST)
	GOOS=linux  GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-amd64 .
	GOOS=linux  GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-linux-arm64 .
	GOOS=darwin GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-darwin-amd64 .
	GOOS=darwin GOARCH=arm64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-darwin-arm64 .
	GOOS=windows GOARCH=amd64 go build -ldflags "$(LDFLAGS)" -o $(DIST)/$(BINARY)-windows-amd64.exe .
	@echo "built binaries in $(DIST)/"

clean:
	rm -f $(BINARY)
	rm -rf $(DIST)
