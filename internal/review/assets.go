package review

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// MaxAssetBytes bounds one upload.
//
// Images are inlined into the rendered document as data: URIs (see
// inlineAsset), which costs about a third again in base64 — so this is really
// a bound on how large a document a phone has to load, not just on disk use.
// Four megabytes is a generous screenshot and an unpleasant page.
const MaxAssetBytes = 4 << 20

// assetTypes are the image types an agent may attach. Sniffed from the bytes;
// a declared content type is not evidence.
var assetTypes = map[string]string{
	"image/png":  ".png",
	"image/jpeg": ".jpg",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// AssetStore holds uploaded images on disk.
type AssetStore struct {
	dir string
}

// NewAssetStore prepares the asset directory, 0700.
func NewAssetStore(stateDir string) (*AssetStore, error) {
	dir := filepath.Join(stateDir, "assets")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create asset dir: %w", err)
	}
	return &AssetStore{dir: dir}, nil
}

// Dir is where assets live.
func (a *AssetStore) Dir() string { return a.dir }

// ErrUnsupportedAsset means the bytes were not an image we accept.
var ErrUnsupportedAsset = fmt.Errorf("unsupported image type")

// Save writes an uploaded image and returns its id, media type and size.
//
// As with pasted images, the filename is generated entirely here and the
// extension comes from sniffing: nothing an agent sends reaches the filesystem
// as a path component, so there is no traversal to defend against.
func (a *AssetStore) Save(r io.Reader) (id, mediaType string, size int64, err error) {
	limited := io.LimitReader(r, MaxAssetBytes+1)

	head := make([]byte, 512)
	n, rerr := io.ReadFull(limited, head)
	if rerr != nil && rerr != io.ErrUnexpectedEOF && rerr != io.EOF {
		return "", "", 0, rerr
	}
	head = head[:n]

	mediaType = http.DetectContentType(head)
	if i := strings.IndexByte(mediaType, ';'); i > 0 {
		mediaType = strings.TrimSpace(mediaType[:i])
	}
	ext, ok := assetTypes[mediaType]
	if !ok {
		return "", "", 0, fmt.Errorf("%w: %s", ErrUnsupportedAsset, mediaType)
	}

	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", "", 0, err
	}
	id = "as_" + hex.EncodeToString(raw)
	path := filepath.Join(a.dir, id+ext)

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
	copied, err := io.Copy(f, limited)
	if err != nil {
		os.Remove(path)
		return "", "", 0, err
	}
	size = int64(written) + copied
	if size > MaxAssetBytes {
		os.Remove(path)
		return "", "", 0, fmt.Errorf("image is larger than %d bytes", MaxAssetBytes)
	}
	return id, mediaType, size, nil
}

// Path returns the on-disk location for an asset id and media type.
func (a *AssetStore) Path(id, mediaType string) string {
	return filepath.Join(a.dir, id+assetTypes[mediaType])
}

// DataURI reads an asset and encodes it for inlining into a rendered document.
//
// Inlining rather than linking is deliberate. The review document renders in an
// iframe sandboxed without allow-same-origin, so it lives in an opaque origin
// where `'self'` matches nothing and the cookie behaviour of a subresource
// request is subtle enough that "it should work" is not good enough for the
// only picture in the document. A data: URI is already permitted by the
// document's own CSP and cannot fail for any of those reasons.
func (a *AssetStore) DataURI(id, mediaType string) (string, error) {
	b, err := os.ReadFile(a.Path(id, mediaType))
	if err != nil {
		return "", err
	}
	return "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(b), nil
}
