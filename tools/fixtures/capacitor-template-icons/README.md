# Fixtures: the Capacitor / Android Studio template's placeholder launcher icons

These five PNGs are the **legacy square `ic_launcher.png`** files from the Android
project template that `npx cap add android` copies into a new project — the blue-cross
artwork Android Studio generates for every new app. They are here so the icon check can
be proved to FAIL on a bundle wearing the placeholder, on a machine with no npm install
and no network.

They are used by `tools/proof-aab-icon-check.sh` (case 2: one launcher icon swapped for
a genuine placeholder) and by the naming-free placeholder scan inside
`tools/aab-independent-verify.sh` section 5.

## Provenance

Extracted from `@capacitor/android` **8.5.2**'s `android-template`
(`app/src/main/res/mipmap-*/ic_launcher.png`), the same files
`tools/android-icons.py` lists in its `PLACEHOLDER_MD5` table so that a build which
fails to install our artwork is caught. Capacitor is MIT-licensed; these files are the
template's, reproduced here only as a test fixture.

| file | density | md5 |
|---|---|---|
| `ic_launcher-mdpi.png` | mdpi | `7ed1b3739b83215d0c4a0b4a7f2dcab4` |
| `ic_launcher-hdpi.png` | hdpi | `1956941339dd5fe36d5c66601c89a08d` |
| `ic_launcher-xhdpi.png` | xhdpi | `5689511ee4e41a367d0342f37ac48bdf` |
| `ic_launcher-xxhdpi.png` | xxhdpi | `a3285eeaedda8201f04e7737b9df8421` |
| `ic_launcher-xxxhdpi.png` | xxxhdpi | `9e029293ab1ae8e3a6a7b7d0b7177e46` |

Every md5 above is a key of `PLACEHOLDER_MD5` in `tools/android-icons.py` — if one ever
stops matching, this fixture directory and that table have drifted apart, and the
placeholder test needs re-deriving from the template.
