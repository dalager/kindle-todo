"""
Wooden frame for the kindle-todo wall display (Kindle Paperwhite 4 / juno / rex).

LASER build: five identical 3 mm birch-ply layers, glued into a 15 mm slab that
hangs FLAT on the wall. One material, one thickness -> any laser cuts it, clean
edges, and every feature is a straight through-cut (no chamfers, no milling).

    L1  Face      window only (covers bezel, shows active area + 0.5 mm reveal)
    L2  Pocket    device pocket + cable slot + power-button relief
    L3  Pocket    + panel screw pilots
    L4  Pocket    + screw pilots + keyhole HEAD CHAMBER (wide slot)
    L5  Back ring + panel rebate opening + keyhole SLOT (narrow) + cable band
    Panel         removable 3 mm, screws into L4/L3 ledge

Keyhole hangers are the classic layer trick: L5 carries the narrow shank slot +
round entry, L4 (just in front) carries a wide chamber so the screw head sits
behind L5 and bears on the face of L3. Two flat cuts = one keyhole.

Outputs (run in FreeCAD):
    exec(open("/home/dalager/projects/kindletodo/frame/kindle_frame.py").read())
  - frame/kindle_frame.step         (3D assembly)
  - frame/laser/kindle_frame.dxf    (all 6 parts nested, Y-up, authoritative)
  - frame/laser/kindle_frame.svg    (same, for services that prefer SVG)

Every dimension is a parameter below. Units: millimetres.
"""

import os
import FreeCAD as App
import Part
from FreeCAD import Vector

# --------------------------------------------------------------------------- #
# Parameters
# --------------------------------------------------------------------------- #

# --- Device: Kindle Paperwhite 4 (10th gen, 2018) ---
# Width from the verified CAD (117.85) not Amazon's nominal 116, so the pocket
# is guaranteed to fit the real device; foam pads take up slack on a 116 unit.
DEV_W, DEV_H, DEV_D = 117.85, 167.0, 8.2
CLR = 0.6
ACT_W, ACT_H = 90.8, 122.6
TOP_BEZEL = 20.0

# --- Laminate: N layers of one ply thickness ---
LAYER_T = 3.0
N_FACE, N_POCKET, N_BACK = 1, 3, 1            # 3+9+3 = 15
STOCK_T = (N_FACE + N_POCKET + N_BACK) * LAYER_T

# --- Face geometry ---
BORDER = 30.0            # wood beside the window (side border, also keyhole meat)
WALL_V = 12.0            # pocket wall top/bottom
WIN_MARGIN = 0.5         # window opens this far past the active area per side
FILLET_R = 4.0           # outer corner radius

# --- Bottom edge: cable + power button ---
USB_W = 14.0             # cable slot, open front-to-back for lay-in
USB_OFFSET = 12.0        # micro-USB sits +12 mm off centre on the bottom edge (CAD)
PAD_W = 15.0             # device rests on two corner pads ...
PAD_RELIEF = 2.0         # ... floor relieved between them (button clearance)

# --- Removable back panel ---
LEDGE_SIDE = 3.0
LEDGE_TB = 5.0           # top/bottom ledges take the screws
SCREW_CLEAR_D = 3.4      # clearance through the panel
SCREW_PILOT_D = 2.7      # pilot into L4/L3 (screw self-threads in ply)

# --- Keyhole hangers ---
KEY_X_INSET = 8.0        # slot centreline from outer edge
KEY_Y_ENTRY = 150.0      # round entry-hole centre
KEY_SLOT_LEN = 22.0      # slide-down travel (slot runs UP from entry)
KEY_HEAD_D = 10.0        # entry hole + head chamber width
KEY_SLOT_W = 5.0         # shank slot width in the back ply

SHOW_KINDLE = True
HERE = "/home/dalager/projects/kindletodo/frame"
STEP_PATH = HERE + "/kindle_frame.step"
LASER_DIR = HERE + "/laser"

# --------------------------------------------------------------------------- #
# Derived
# --------------------------------------------------------------------------- #

pocket_w = DEV_W + 2 * CLR
pocket_h = DEV_H + 2 * CLR
OUTER_W = ACT_W + 2 * BORDER
OUTER_H = pocket_h + 2 * WALL_V
pkt_x0 = (OUTER_W - pocket_w) / 2.0
pkt_y0 = WALL_V
dev_x0 = pkt_x0 + CLR
dev_y0 = pkt_y0 + CLR

win_w = ACT_W + 2 * WIN_MARGIN
win_h = ACT_H + 2 * WIN_MARGIN
win_x0 = (OUTER_W - win_w) / 2.0
win_y0 = dev_y0 + (DEV_H - ACT_H - TOP_BEZEL) - WIN_MARGIN

reb_w = pocket_w + 2 * LEDGE_SIDE
reb_h = pocket_h + 2 * LEDGE_TB
reb_x0 = (OUTER_W - reb_w) / 2.0
reb_y0 = (OUTER_H - reb_h) / 2.0
usb_x0 = (OUTER_W - USB_W) / 2.0 + USB_OFFSET

z_face = N_FACE * LAYER_T
z_pocket = (N_FACE + N_POCKET) * LAYER_T
EPS = 0.1

screw_pts = [(40.0, reb_y0 + LEDGE_TB / 2.0),
             (OUTER_W - 40.0, reb_y0 + LEDGE_TB / 2.0),
             (40.0, pkt_y0 + pocket_h + LEDGE_TB / 2.0),
             (OUTER_W / 2.0, pkt_y0 + pocket_h + LEDGE_TB / 2.0),
             (OUTER_W - 40.0, pkt_y0 + pocket_h + LEDGE_TB / 2.0)]

# Layer table: (name, z0)
layers = ([("L1_Face", 0.0)]
          + [("L%d_Pocket" % (2 + i), z_face + i * LAYER_T) for i in range(N_POCKET)]
          + [("L%d_Back" % (2 + N_POCKET), z_pocket)])


def box(w, h, d, x, y, z):
    return Part.makeBox(w, h, d, Vector(x, y, z))


def cyl(r, h, x, y, z, dz=1):
    return Part.makeCylinder(r, h, Vector(x, y, z), Vector(0, 0, dz))


# --------------------------------------------------------------------------- #
# Feature solids (absolute Z; each layer subtracts the whole set)
# --------------------------------------------------------------------------- #

feats = []
# window -> face layers
feats.append(box(win_w, win_h, z_face + EPS, win_x0, win_y0, -EPS / 2))
# device pocket -> pocket layers
feats.append(box(pocket_w, pocket_h, N_POCKET * LAYER_T + EPS,
                 pkt_x0, pkt_y0, z_face - EPS / 2))
# panel rebate opening -> back layer
feats.append(box(reb_w, reb_h, N_BACK * LAYER_T + EPS,
                 reb_x0, reb_y0, z_pocket - EPS / 2))
# cable slot: bottom edge into pocket, open front->back -> pocket + back layers
feats.append(box(USB_W, pkt_y0 + CLR + EPS, (N_POCKET + N_BACK) * LAYER_T + EPS,
                 usb_x0, -EPS / 2, z_face - EPS / 2))
# power-button relief: floor between the two corner pads -> pocket layers
feats.append(box(pocket_w - 2 * PAD_W, PAD_RELIEF + CLR + EPS,
                 N_POCKET * LAYER_T + EPS,
                 pkt_x0 + PAD_W, pkt_y0 - PAD_RELIEF, z_face - EPS / 2))
# panel screw pilots -> L3 + L4 (from the ledge at z_pocket, forward)
for (x, y) in screw_pts:
    feats.append(cyl(SCREW_PILOT_D / 2, 2 * LAYER_T + EPS, x, y, z_pocket + EPS, -1))
# keyholes
for xc in (KEY_X_INSET, OUTER_W - KEY_X_INSET):
    # L5 back ply: round entry + NARROW shank slot (running up)
    feats.append(cyl(KEY_HEAD_D / 2, N_BACK * LAYER_T + EPS, xc, KEY_Y_ENTRY,
                     z_pocket - EPS / 2, 1))
    feats.append(box(KEY_SLOT_W, KEY_SLOT_LEN, N_BACK * LAYER_T + EPS,
                     xc - KEY_SLOT_W / 2, KEY_Y_ENTRY, z_pocket - EPS / 2))
    # L4 ply (in front): round entry + WIDE head chamber
    zc = z_pocket - LAYER_T
    feats.append(cyl(KEY_HEAD_D / 2, LAYER_T + EPS, xc, KEY_Y_ENTRY, zc - EPS / 2, 1))
    feats.append(box(KEY_HEAD_D, KEY_SLOT_LEN, LAYER_T + EPS,
                     xc - KEY_HEAD_D / 2, KEY_Y_ENTRY, zc - EPS / 2))


def outer_fillet(shape):
    edges = []
    for e in shape.Edges:
        vs = e.Vertexes
        if len(vs) == 2:
            a, b = vs
            if (abs(a.X - b.X) < 1e-6 and abs(a.Y - b.Y) < 1e-6
                    and abs(a.Z - b.Z) > 1
                    and (abs(a.X) < 1e-6 or abs(a.X - OUTER_W) < 1e-6)
                    and (abs(a.Y) < 1e-6 or abs(a.Y - OUTER_H) < 1e-6)):
                edges.append(e)
    try:
        return shape.makeFillet(FILLET_R, edges)
    except Exception as ex:
        print("fillet skipped -", ex)
        return shape


# --------------------------------------------------------------------------- #
# Build 3D assembly
# --------------------------------------------------------------------------- #

doc = (App.getDocument("KindleFrame")
       if "KindleFrame" in [d.Name for d in App.listDocuments().values()]
       else App.newDocument("KindleFrame"))
for o in list(doc.Objects):
    doc.removeObject(o.Name)

layer_solids = {}
for i, (name, z0) in enumerate(layers):
    s = box(OUTER_W, OUTER_H, LAYER_T, 0, 0, z0)
    for f in feats:
        s = s.cut(f)
    s = outer_fillet(s)
    layer_solids[name] = s
    o = doc.addObject("Part::Feature", name)
    o.Shape = s
    if getattr(o, "ViewObject", None):
        o.ViewObject.ShapeColor = (0.62, 0.44, 0.24) if i % 2 else (0.52, 0.35, 0.18)

panel = box(reb_w - 0.4, reb_h - 0.4, LAYER_T, reb_x0 + 0.2, reb_y0 + 0.2, z_pocket)
for (x, y) in screw_pts:
    panel = panel.cut(cyl(SCREW_CLEAR_D / 2, LAYER_T + 2 * EPS, x, y, z_pocket - EPS, 1))
layer_solids["BackPanel"] = panel
po = doc.addObject("Part::Feature", "BackPanel")
po.Shape = panel
if getattr(po, "ViewObject", None):
    po.ViewObject.ShapeColor = (0.72, 0.55, 0.33)

if SHOW_KINDLE:
    dev = box(DEV_W, DEV_H, DEV_D, dev_x0, dev_y0, z_face)
    screen = box(ACT_W, ACT_H, 0.6, dev_x0 + (DEV_W - ACT_W) / 2,
                 dev_y0 + (DEV_H - ACT_H - TOP_BEZEL), z_face - 0.3)
    for shp, nm, col in ((dev, "Kindle_Body", (0.10, 0.10, 0.11)),
                         (screen, "Kindle_Screen", (0.85, 0.86, 0.88))):
        oo = doc.addObject("Part::Feature", nm)
        oo.Shape = shp
        if getattr(oo, "ViewObject", None):
            oo.ViewObject.ShapeColor = col

doc.recompute()

try:
    parts = [doc.getObject(n) for (n, _) in layers] + [doc.getObject("BackPanel")]
    Part.export(parts, STEP_PATH)
    print("exported STEP ->", STEP_PATH)
except Exception as ex:
    print("STEP export skipped -", ex)

# --------------------------------------------------------------------------- #
# Flat cut files: bottom profile of every part, nested in a grid
# --------------------------------------------------------------------------- #

def bottom_profile(shape, z0):
    edges = [e for e in shape.Edges
             if e.Vertexes and all(abs(v.Z - z0) < 1e-6 for v in e.Vertexes)]
    c = Part.makeCompound(edges)
    c = c.copy()
    c.translate(Vector(0, 0, -z0))
    return c

flat_order = [(n, z0) for (n, z0) in layers] + [("BackPanel", z_pocket)]
GAP = 14.0
cell_w = OUTER_W + GAP
cell_h = OUTER_H + GAP
flat_objs = []
flat_doc = (App.getDocument("KindleFrameFlat")
            if "KindleFrameFlat" in [d.Name for d in App.listDocuments().values()]
            else App.newDocument("KindleFrameFlat"))
for o in list(flat_doc.Objects):
    flat_doc.removeObject(o.Name)

for idx, (name, z0) in enumerate(flat_order):
    prof = bottom_profile(layer_solids[name], z0)
    col, row = idx % 3, idx // 3
    prof.translate(Vector(col * cell_w, row * cell_h, 0))
    fo = flat_doc.addObject("Part::Feature", "flat_" + name)
    fo.Shape = prof
    if getattr(fo, "ViewObject", None):
        fo.ViewObject.LineColor = (0.15, 0.15, 0.15)
        fo.ViewObject.LineWidth = 2.0
    flat_objs.append(fo)
flat_doc.recompute()

os.makedirs(LASER_DIR, exist_ok=True)
try:
    import importDXF
    importDXF.export(flat_objs, LASER_DIR + "/kindle_frame.dxf")
    print("exported DXF -> %s/kindle_frame.dxf" % LASER_DIR)
except Exception as ex:
    print("DXF export skipped -", ex)
try:
    import importSVG
    importSVG.export(flat_objs, LASER_DIR + "/kindle_frame.svg")
    print("exported SVG -> %s/kindle_frame.svg" % LASER_DIR)
except Exception as ex:
    print("SVG export skipped -", ex)

try:
    import FreeCADGui as Gui
    Gui.activeDocument().activeView().viewIsometric()
    Gui.SendMsgToActiveView("ViewFit")
except Exception:
    pass

print("Built %s: %.1f x %.1f x %.1f mm | %d layers x %.0f mm ply + panel | 6 unique parts"
      % ("KindleFrame", OUTER_W, OUTER_H, STOCK_T,
         N_FACE + N_POCKET + N_BACK, LAYER_T))
print("Hang on two screws (head <= %.1f mm), %.1f mm apart, level."
      % (KEY_HEAD_D - 1.5, OUTER_W - 2 * KEY_X_INSET))
