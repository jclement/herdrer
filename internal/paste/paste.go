// Package paste accepts an image from the browser and puts it somewhere an
// agent can read, returning a path to type at it.
//
// This exists because a terminal cannot carry an image. xterm.js hands the page
// a File on paste, but the far end is a PTY — a byte stream — and the escape
// sequences that do exist for images (kitty, iTerm2) are for *display*, not for
// handing a file to a program. Meanwhile both Claude Code and Codex will read
// an image if you give them a path. So the image travels out of band over HTTP,
// and what goes down the PTY is the one thing a terminal is good at: text.
package paste

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MaxBytes bounds one paste. Generous for a screenshot, far below anything that
// would fill a disk by accident.
const MaxBytes = 12 << 20 // 12 MiB

// retention is how long a pasted image survives. Long enough to still be there
// when an agent gets round to reading it, short enough that a dev box does not
// accumulate screenshots forever.
const retention = 24 * time.Hour

// allowed maps a sniffed content type to the extension we will write.
//
// The extension comes from the *bytes*, never from the client. A client-supplied
// filename is an attacker-supplied filename: it is how you get `../`, a leading
// dash that the next command parses as a flag, or a name full of shell
// metacharacters that some later tool re-splits.
var allowed = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// Store writes pasted images into a directory.
type Store struct {
	dir string
}

// New prepares the paste directory, 0700.
func New(stateDir string) (*Store, error) {
	dir := filepath.Join(stateDir, "pastes")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create paste dir: %w", err)
	}
	return &Store{dir: dir}, nil
}

// Dir is where pastes land.
func (s *Store) Dir() string { return s.dir }

// ErrUnsupported means the bytes were not an image we accept.
var ErrUnsupported = fmt.Errorf("unsupported image type")

// Save reads an image from r and writes it under a generated name.
//
// It returns the absolute path, which is safe to inject into a shell by
// construction: the directory is fixed, the basename is hex, and the extension
// comes from a closed set. There is no input from the caller anywhere in it, so
// there is nothing to quote or escape.
func (s *Store) Save(r io.Reader) (path string, contentType string, size int64, err error) {
	limited := io.LimitReader(r, MaxBytes+1)

	// Sniff from the first 512 bytes, which is what DetectContentType reads,
	// then write those bytes plus the rest.
	head := make([]byte, 512)
	n, err := io.ReadFull(limited, head)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return "", "", 0, err
	}
	head = head[:n]

	contentType = http.DetectContentType(head)
	// DetectContentType may return a parameterised type.
	if i := strings.IndexByte(contentType, ';'); i > 0 {
		contentType = strings.TrimSpace(contentType[:i])
	}
	ext, ok := allowed[contentType]
	if !ok {
		return "", "", 0, fmt.Errorf("%w: %s", ErrUnsupported, contentType)
	}

	name := make([]byte, 8)
	if _, err := rand.Read(name); err != nil {
		return "", "", 0, err
	}
	path = filepath.Join(s.dir, hex.EncodeToString(name)+ext)

	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return "", "", 0, err
	}
	defer f.Close()

	written, err := f.Write(head)
	if err != nil {
		os.Remove(path)
		return "", "", 0, err
	}
	size = int64(written)

	copied, err := io.Copy(f, limited)
	if err != nil {
		os.Remove(path)
		return "", "", 0, err
	}
	size += copied

	if size > MaxBytes {
		os.Remove(path)
		return "", "", 0, fmt.Errorf("image is larger than %d bytes", MaxBytes)
	}
	return path, contentType, size, nil
}

// StartReaper deletes pasted images older than the retention window.
func (s *Store) StartReaper(stop <-chan struct{}) {
	go func() {
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for {
			s.reap()
			select {
			case <-stop:
				return
			case <-t.C:
			}
		}
	}()
}

func (s *Store) reap() {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-retention)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		p := filepath.Join(s.dir, e.Name())
		if err := os.Remove(p); err != nil {
			slog.Warn("could not reap paste", "path", p, "err", err)
		}
	}
}
