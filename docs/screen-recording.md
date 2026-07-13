# macOS Screen Recording permission (and why a stable signature matters)

The native `shot` capture needs the **host app** to hold **Screen Recording**
permission (System Settings → Privacy & Security → Screen Recording). If it
doesn't, the host reports the real reason, e.g.:

```
SCShareableContent failed: The user declined TCCs … code -3801
```

`-3801` is a permission denial, **not** a bug in the capture code.

The trap: macOS keys the grant to the app's **code signature**. An **ad-hoc**
signature (the default for local/Debug builds) gets a *fresh cdhash on every
rebuild*, so the grant evaporates and you're back to `-3801` after each build —
even though you "already allowed it". Fix it by signing the Standalone with a
**stable** self-signed identity so the designated requirement stays constant:

```bash
# 1. once: make a self-signed Code Signing cert in the login keychain
#    (Keychain Access → Certificate Assistant → Create a Certificate →
#     Self-Signed Root, type "Code Signing"), e.g. named "My Local Codesign".
# 2. re-sign the built app with it (e.g. a POST_BUILD codesign step in your CMake):
codesign --force --deep --sign "My Local Codesign" MyApp.app
# 3. clear any stale grant, then approve once in System Settings:
tccutil reset ScreenCapture com.example.myapp
```

After approving once, the grant **survives rebuilds** (same cert → same
designated requirement). SCK reads the permission at launch, so **relaunch the
app** after granting. Note `security find-identity -p codesigning` may show the
self-signed cert as not-a-valid-identity (it isn't *trusted*), yet `codesign`
signs with it fine — that's expected.
