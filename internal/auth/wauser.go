package auth

import (
	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// waUser adapts a herdrer user to the webauthn.User interface.
//
// WebAuthnID returns the user's UUID as bytes. It is the value the
// authenticator stores as the user handle and hands back on a discoverable
// login, so it must be stable for the life of the account and must be what
// authorisation decisions key on — never the handle, which is display text.
type waUser struct {
	id      string
	handle  string
	display string
	creds   []webauthn.Credential
}

func (u *waUser) WebAuthnID() []byte                         { return []byte(u.id) }
func (u *waUser) WebAuthnName() string                       { return u.handle }
func (u *waUser) WebAuthnDisplayName() string                { return u.display }
func (u *waUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

// excludeList stops an authenticator that already holds a credential for this
// account from silently registering a second one.
func (u *waUser) excludeList() []protocol.CredentialDescriptor {
	out := make([]protocol.CredentialDescriptor, 0, len(u.creds))
	for _, c := range u.creds {
		out = append(out, protocol.CredentialDescriptor{
			Type:         protocol.PublicKeyCredentialType,
			CredentialID: c.ID,
			Transport:    c.Transport,
		})
	}
	return out
}
