# Native workbench provenance

The native document core, overlay mapping, phase calculations, parameter catalog
and default profile were migrated from the user's local RoastWorkbench 0.2.2
source in `kaffelogic逆向/src/roastworkbench` on 2026-10-21. Core calculations
and lossless native line storage are preserved. Resource lookup uses this
package; the phase calculation module excludes the Qt widget layer.

The catalog contains reference-derived Chinese strings and parameter help;
the default profile is reference-derived material. Their provenance is recorded
in the reference project's `analysis/localization/NOTICE.md` and
`THIRD_PARTY_NOTICES.md`. They are not claimed as original translations or
artwork. Original executable, bytecode, wx/Qt runtime, activation code, research
tools, private roast samples and device discovery are not product dependencies.

The engine uses Python (PSF license), NumPy (BSD license and bundled numerical
library notices), and the PyInstaller bootloader (GPL with distribution
exception). Their notices are included by the standalone packager.
