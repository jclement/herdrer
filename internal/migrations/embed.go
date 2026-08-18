// Package migrations holds the numbered SQL migrations, embedded in the binary
// so a deployment is one file and applying them needs no external tool.
package migrations

import "embed"

// FS contains every *.sql migration, applied in lexical order.
//
//go:embed *.sql
var FS embed.FS
