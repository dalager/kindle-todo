"""
Build the 3D-print STL from the parametric model.

Fuses the five frame layers into ONE solid (a print wants a single body, not a
lamination) and excludes the removable back panel — print or cut that separately.

Run headless, NOT through the FreeCAD MCP bridge:

    cd frame && snap run freecad.cmd make_stl.py

Writes frame/kindle_frame_print.stl
"""

import os
import traceback

import Mesh

HERE = "/home/dalager/projects/kindletodo/frame"
OUT = HERE + "/kindle_frame_print.stl"
TESSELLATION = 0.04  # mm deviation; small enough that the fillets/holes look smooth

try:
    # Builds the model and defines `layers` + `layer_solids`
    exec(open(HERE + "/kindle_frame.py").read())

    frame_names = [n for (n, _) in layers]  # L1_Face .. L5_Back (no BackPanel)
    print("fusing:", frame_names)

    fused = layer_solids[frame_names[0]]
    for n in frame_names[1:]:
        fused = fused.fuse(layer_solids[n])
    try:
        fused = fused.removeSplitter()  # merge coplanar faces left by the union
    except Exception as ex:
        print("removeSplitter skipped -", ex)

    bb = fused.BoundBox
    print("RESULT solids=%d  volume=%.1f cm3  bbox %.1f x %.1f x %.1f mm"
          % (len(fused.Solids), fused.Volume / 1000.0,
             bb.XLength, bb.YLength, bb.ZLength))
    if len(fused.Solids) != 1:
        print("WARNING: expected a single solid — check the model before printing")

    Mesh.Mesh(fused.tessellate(TESSELLATION)).write(OUT)
    print("STL", os.path.exists(OUT), os.path.getsize(OUT), OUT)
except Exception:
    traceback.print_exc()
