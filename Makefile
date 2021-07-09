EXCLUDES := tblatex*.xpi Makefile TODO
VERSION := $(shell jq .version manifest.json)
OUTPUT_FILE := tblatex_v$(VERSION).xpi

all: dist

.PHONY: dist
dist:
	rm -f $(OUTPUT_FILE)
	zip $(OUTPUT_FILE) -x ${EXCLUDES} -r *
