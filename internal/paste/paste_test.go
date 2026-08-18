package paste

import (
	"bytes"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// pngBytes is a minimal valid PNG header — enough for content sniffing.
var pngBytes = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 600)...)

func TestSaveWritesSniffedExtension(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path, ct, size, err := s.Save(bytes.NewReader(pngBytes))
	if err != nil {
		t.Fatal(err)
	}
	if ct != "image/png" {
		t.Errorf("content type = %q", ct)
	}
	if !strings.HasSuffix(path, ".png") {
		t.Errorf("path %q does not end .png", path)
	}
	if size != int64(len(pngBytes)) {
		t.Errorf("size = %d, want %d", size, len(pngBytes))
	}
	if fi, err := os.Stat(path); err != nil {
		t.Fatal(err)
	} else if fi.Mode().Perm() != 0o600 {
		t.Errorf("mode = %v, want 0600", fi.Mode().Perm())
	}
}

// TestSavedPathIsShellSafe is the load-bearing test.
//
// The returned path is injected into a PTY as if typed, in front of an agent
// that may act on the resulting command line. Nothing in it may come from the
// caller, and it must contain no character that a shell would treat specially —
// that is what makes the injection safe by construction rather than by quoting.
func TestSavedPathIsShellSafe(t *testing.T) {
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	safe := regexp.MustCompile(`^[A-Za-z0-9_./-]+$`)
	for i := 0; i < 40; i++ {
		path, _, _, err := s.Save(bytes.NewReader(pngBytes))
		if err != nil {
			t.Fatal(err)
		}
		if !safe.MatchString(path) {
			t.Fatalf("path %q contains a character a shell could interpret", path)
		}
		base := filepath.Base(path)
		if strings.HasPrefix(base, "-") {
			t.Fatalf("basename %q starts with a dash; the next command would parse it as a flag", base)
		}
		if filepath.Dir(path) != s.Dir() {
			t.Fatalf("path escaped the paste directory: %q", path)
		}
	}
}

// TestSaveRejectsNonImages keeps this from becoming a general-purpose
// write-anything-to-the-box endpoint.
func TestSaveRejectsNonImages(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string][]byte{
		"shell script": []byte("#!/bin/sh\nrm -rf /\n"),
		"elf binary":   append([]byte("\x7fELF"), bytes.Repeat([]byte{0}, 600)...),
		"html":         []byte("<!doctype html><script>alert(1)</script>"),
		"empty":        {},
	} {
		if _, _, _, err := s.Save(bytes.NewReader(body)); err == nil {
			t.Errorf("%s was accepted as an image", name)
		}
	}
	// And nothing was left behind by a rejected upload.
	entries, _ := os.ReadDir(s.Dir())
	if len(entries) != 0 {
		t.Errorf("rejected uploads left %d files behind", len(entries))
	}
}

// TestSaveEnforcesSizeLimit checks the cap, and that an over-limit upload does
// not leave a partial file on disk.
func TestSaveEnforcesSizeLimit(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	huge := append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{7}, MaxBytes+1024)...)
	if _, _, _, err := s.Save(bytes.NewReader(huge)); err == nil {
		t.Fatal("an oversized image was accepted")
	}
	entries, _ := os.ReadDir(s.Dir())
	if len(entries) != 0 {
		t.Errorf("an oversized upload left %d files behind", len(entries))
	}
}

// TestReapRemovesOldPastes keeps a dev box from filling with screenshots.
func TestReapRemovesOldPastes(t *testing.T) {
	s, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	fresh, _, _, err := s.Save(bytes.NewReader(pngBytes))
	if err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(s.Dir(), "deadbeefdeadbeef.png")
	if err := os.WriteFile(old, pngBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	ancient := timeLongAgo()
	if err := os.Chtimes(old, ancient, ancient); err != nil {
		t.Fatal(err)
	}

	s.reap()

	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Error("an expired paste was not reaped")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("a fresh paste was reaped")
	}
}

func timeLongAgo() time.Time { return time.Now().Add(-2 * retention) }
