// Package webui embeds the built SPA so a deployment is one file.
package webui

import (
	"embed"
	"io/fs"
)

// dist holds the Vite build output. The all: prefix keeps files whose names
// begin with an underscore, which Vite emits.
//
//go:embed all:dist
var dist embed.FS

// FS returns the SPA rooted at dist/, or an error if the binary was built
// without a web build.
func FS() (fs.FS, error) {
	return fs.Sub(dist, "dist")
}

// Present reports whether a real SPA was embedded, as opposed to the
// placeholder that keeps `go build` working before the first web build.
func Present() bool {
	entries, err := dist.ReadDir("dist")
	if err != nil {
		return false
	}
	for _, e := range entries {
		if e.Name() == "index.html" {
			return true
		}
	}
	return false
}
