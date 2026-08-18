package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math/big"
	"testing"

	"github.com/fxamacker/cbor/v2"
)

// virtualAuthenticator is a minimal WebAuthn authenticator, enough to drive a
// real registration and assertion against the server.
//
// It exists because the WebAuthn ceremony was the one path no test covered —
// it cannot be driven without an authenticator — and that is exactly where the
// first real bug showed up, on a phone, with a deliberately opaque error
// message. A software authenticator turns "reload and try again" into a stack
// trace on a laptop.
type virtualAuthenticator struct {
	key       *ecdsa.PrivateKey
	credID    []byte
	aaguid    []byte
	signCount uint32
	// uv reports user verification. The server requires it; a test can turn it
	// off to prove the server actually rejects a presence-only authenticator.
	uv bool
}

func newVirtualAuthenticator(t *testing.T) *virtualAuthenticator {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	credID := make([]byte, 32)
	if _, err := rand.Read(credID); err != nil {
		t.Fatal(err)
	}
	return &virtualAuthenticator{key: key, credID: credID, aaguid: make([]byte, 16), uv: true}
}

// coseKey encodes the public key as a COSE_Key for ES256.
func (a *virtualAuthenticator) coseKey(t *testing.T) []byte {
	t.Helper()
	x := make([]byte, 32)
	y := make([]byte, 32)
	a.key.PublicKey.X.FillBytes(x)
	a.key.PublicKey.Y.FillBytes(y)

	// Canonical CBOR with integer keys, per RFC 8152.
	km := map[int]any{
		1:  2,  // kty: EC2
		3:  -7, // alg: ES256
		-1: 1,  // crv: P-256
		-2: x,
		-3: y,
	}
	em, err := cbor.CanonicalEncOptions().EncMode()
	if err != nil {
		t.Fatal(err)
	}
	b, err := em.Marshal(km)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// WebAuthn authenticator data flags.
const (
	flagUP = 1 << 0 // user present
	flagUV = 1 << 2 // user verified
	flagBE = 1 << 3 // backup eligible
	flagBS = 1 << 4 // backup state
	flagAT = 1 << 6 // attested credential data included
)

func (a *virtualAuthenticator) authData(t *testing.T, rpID string, attested bool) []byte {
	t.Helper()
	rpHash := sha256.Sum256([]byte(rpID))

	var flags byte = flagUP | flagBE | flagBS
	if a.uv {
		flags |= flagUV
	}
	if attested {
		flags |= flagAT
	}

	out := append([]byte{}, rpHash[:]...)
	out = append(out, flags)

	var counter [4]byte
	binary.BigEndian.PutUint32(counter[:], a.signCount)
	out = append(out, counter[:]...)

	if attested {
		out = append(out, a.aaguid...)
		var idLen [2]byte
		binary.BigEndian.PutUint16(idLen[:], uint16(len(a.credID)))
		out = append(out, idLen[:]...)
		out = append(out, a.credID...)
		out = append(out, a.coseKey(t)...)
	}
	return out
}

func clientDataJSON(t *testing.T, typ, challenge, origin string) []byte {
	t.Helper()
	b, err := json.Marshal(map[string]any{
		"type":        typ,
		"challenge":   challenge,
		"origin":      origin,
		"crossOrigin": false,
	})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// Register produces the JSON body the browser would POST to register/finish.
func (a *virtualAuthenticator) Register(t *testing.T, challenge, rpID, origin string) []byte {
	t.Helper()
	cd := clientDataJSON(t, "webauthn.create", challenge, origin)
	ad := a.authData(t, rpID, true)

	em, err := cbor.CanonicalEncOptions().EncMode()
	if err != nil {
		t.Fatal(err)
	}
	attObj, err := em.Marshal(map[string]any{
		"fmt":      "none",
		"attStmt":  map[string]any{},
		"authData": ad,
	})
	if err != nil {
		t.Fatal(err)
	}

	b64 := base64.RawURLEncoding
	body, err := json.Marshal(map[string]any{
		"id":    b64.EncodeToString(a.credID),
		"rawId": b64.EncodeToString(a.credID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    b64.EncodeToString(cd),
			"attestationObject": b64.EncodeToString(attObj),
			"transports":        []string{"internal", "hybrid"},
		},
		"clientExtensionResults":  map[string]any{},
		"authenticatorAttachment": "platform",
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// Assert produces the JSON body for a login or step-up finish.
func (a *virtualAuthenticator) Assert(t *testing.T, challenge, rpID, origin string, userHandle []byte) []byte {
	t.Helper()
	a.signCount++
	cd := clientDataJSON(t, "webauthn.get", challenge, origin)
	ad := a.authData(t, rpID, false)

	cdHash := sha256.Sum256(cd)
	signed := append(append([]byte{}, ad...), cdHash[:]...)
	digest := sha256.Sum256(signed)

	r, s, err := ecdsa.Sign(rand.Reader, a.key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	sig, err := asn1ECDSASignature(r, s)
	if err != nil {
		t.Fatal(err)
	}

	b64 := base64.RawURLEncoding
	resp := map[string]any{
		"clientDataJSON":    b64.EncodeToString(cd),
		"authenticatorData": b64.EncodeToString(ad),
		"signature":         b64.EncodeToString(sig),
	}
	if userHandle != nil {
		resp["userHandle"] = b64.EncodeToString(userHandle)
	}
	body, err := json.Marshal(map[string]any{
		"id":                     b64.EncodeToString(a.credID),
		"rawId":                  b64.EncodeToString(a.credID),
		"type":                   "public-key",
		"response":               resp,
		"clientExtensionResults": map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

// asn1ECDSASignature encodes (r,s) as the DER SEQUENCE WebAuthn expects.
func asn1ECDSASignature(r, s *big.Int) ([]byte, error) {
	return asn1.Marshal(struct{ R, S *big.Int }{R: r, S: s})
}
