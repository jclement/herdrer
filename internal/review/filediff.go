package review

import (
	"fmt"
	"strings"

	"github.com/pmezard/go-difflib/difflib"
)

// fullFileContext is the context used when an agent does not ask for a
// specific amount.
//
// Deliberately enormous: an agent that sends before and after is saying "here
// is the whole change, decide for yourself what matters", and the reader
// scrolling past unchanged lines is a far smaller cost than a reviewer who
// cannot see the three lines above a hunk that would have explained it. The UI
// collapses runs of unchanged lines, so the size is not paid on screen.
const fullFileContext = 1 << 20

// maxDiffInputBytes bounds one side of a pair. Past this the diff is not a
// document anyone reads, and computing it costs more than it is worth.
const maxDiffInputBytes = 2 << 20

// buildFileDiff turns a before/after pair into a unified diff.
//
// The agent sends whole files; herdrer does the diffing. That split is on
// purpose — an agent choosing which hunks to show is an agent deciding what the
// human is allowed to notice, and the times it matters most are exactly the
// times its judgement is what you are checking.
func buildFileDiff(path, before, after string, context int) (string, error) {
	if len(before) > maxDiffInputBytes || len(after) > maxDiffInputBytes {
		return "", fmt.Errorf("%w: a file in this pair is over %d bytes", ErrValidation, maxDiffInputBytes)
	}
	if before == after {
		return "", nil
	}
	if context <= 0 {
		context = fullFileContext
	}

	name := path
	if name == "" {
		name = "file"
	}
	out, err := difflib.GetUnifiedDiffString(difflib.UnifiedDiff{
		A:        difflib.SplitLines(normaliseEOL(before)),
		B:        difflib.SplitLines(normaliseEOL(after)),
		FromFile: "a/" + name,
		ToFile:   "b/" + name,
		Context:  context,
	})
	if err != nil {
		return "", fmt.Errorf("diff %s: %w", name, err)
	}
	return out, nil
}

// normaliseEOL keeps a CRLF file from diffing as though every line changed,
// which is what happens when one side came off a Windows checkout.
func normaliseEOL(s string) string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	if s != "" && !strings.HasSuffix(s, "\n") {
		s += "\n"
	}
	return s
}

// diffStat counts added and removed lines, for a summary the reader sees before
// deciding to open a long diff.
func diffStat(unified string) (added, removed int) {
	for _, line := range strings.Split(unified, "\n") {
		switch {
		case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
			continue
		case strings.HasPrefix(line, "+"):
			added++
		case strings.HasPrefix(line, "-"):
			removed++
		}
	}
	return added, removed
}
