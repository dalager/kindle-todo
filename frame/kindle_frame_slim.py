"""
Slim 3D-printed frame for the kindle-todo wall display (Kindle Paperwhite 4).

Print-only sibling of kindle_frame.py. The laminated design needs wide walls for
its keyhole slots and back-panel screws; a print is strong enough without them,
so this one is just a 3 mm wall around the device:

    Frame       face with the window (still hides the Kindle bezel) + 3 mm walls,
                open back, no keyholes, no back panel.
    Wall plate  3 mm plate that screws to the wall. Its bevelled top edge is a
                French cleat: a matching lip inside the frame's top wall hooks
                over it. The plate sits in the gap behind the Kindle, so it also
                keeps the device in the pocket.

Z runs front -> wall: face at z=0, back of the frame (against the wall) at DEPTH.

Run headless:
    cd frame && flatpak run --command=FreeCADCmd org.freecad.FreeCAD kindle_frame_slim.py

Writes kindle_frame_slim.stl, kindle_frame_slim_wallplate.stl and
kindle_frame_slim.step next to this file. Units: millimetres.
"""

import math
import os
import traceback

import FreeCAD as App
import Mesh
import Part
from FreeCAD import Vector

# --------------------------------------------------------------------------- #
# Parameters
# --------------------------------------------------------------------------- #

# --- Device: Kindle Paperwhite 4 (same numbers as kindle_frame.py) ---
DEV_W, DEV_H, DEV_D = 117.85, 167.0, 8.2
CLR = 0.6
ACT_W, ACT_H = 90.8, 122.6
TOP_BEZEL = 20.0

# --- Frame ---
WALL = 3.0               # wall around the device, all four sides
FACE_T = 3.0             # front face thickness
DEPTH = 15.0             # total depth; back sits flat on the wall
WIN_MARGIN = 0.5         # window opens this far past the active area per side
BEVEL_ANGLE = 45.0       # passe-partout bevel on the window edge, from the face normal
BEVEL_LAND = 0.6         # square edge left at the screen so the bevel is not a knife
FILLET_R = 3.0           # outer corner radius (= WALL keeps the corner 3 mm thick)

# --- Bottom edge: cable + power button ---
USB_W = 14.0             # cable slot through the bottom wall, open to the back
USB_OFFSET = 12.0        # micro-USB sits +12 mm off centre
PAD_W = 15.0             # device rests on two corner pads ...
PAD_RELIEF = 1.0         # ... floor relieved between them (button clearance)

# --- Wall plate / cleat ---
PLATE_T = 3.0            # plate thickness; lives between device back and wall
PLATE_SIDE_CLR = 1.0     # plate is this much narrower than the pocket per side
PLATE_H = 120.0          # tall enough that the Kindle cannot lean back
CLEAT = 3.0              # 45 deg hook: lip height = lip depth
PLATE_TIP_FLAT = 0.6     # blunt the plate's knife edge
SCREW_D = 4.5            # clearance for 4 mm countersunk wall screws
SCREW_HEAD_D = 8.6       # countersink diameter (90 deg)
SCREW_X = 35.0           # screw columns, +/- from the centreline
SCREW_Y_INSET = 18.0     # screw rows, from the plate's top and bottom edges

TESSELLATION = 0.04
HERE = os.path.dirname(os.path.abspath(globals().get("__file__", "x")))

# --------------------------------------------------------------------------- #
# Derived
# --------------------------------------------------------------------------- #

pocket_w = DEV_W + 2 * CLR
pocket_h = DEV_H + 2 * CLR
OUTER_W = pocket_w + 2 * WALL
OUTER_H = pocket_h + 2 * WALL
pkt_x0, pkt_y0 = WALL, WALL
pkt_top = pkt_y0 + pocket_h
dev_x0, dev_y0 = pkt_x0 + CLR, pkt_y0 + CLR

win_w = ACT_W + 2 * WIN_MARGIN
win_h = ACT_H + 2 * WIN_MARGIN
win_x0 = (OUTER_W - win_w) / 2.0
win_y0 = dev_y0 + (DEV_H - ACT_H - TOP_BEZEL) - WIN_MARGIN
bevel_z = FACE_T - BEVEL_LAND                       # bevel runs z=0 .. bevel_z
bevel_grow = bevel_z * math.tan(math.radians(BEVEL_ANGLE))
usb_x0 = (OUTER_W - USB_W) / 2.0 + USB_OFFSET

plate_z0 = DEPTH - PLATE_T
assert plate_z0 >= FACE_T + DEV_D + 0.5, "no room for the plate behind the device"
assert PAD_RELIEF < WALL - 1.0, "button relief leaves the bottom wall too thin"
EPS = 0.1


def box(w, h, d, x, y, z):
    return Part.makeBox(w, h, d, Vector(x, y, z))


def rect_wire(x, y, w, h, z, grow):
    """Rectangle outline at height z, enlarged by `grow` on every side."""
    pts = [Vector(x - grow, y - grow, z), Vector(x + w + grow, y - grow, z),
           Vector(x + w + grow, y + h + grow, z), Vector(x - grow, y + h + grow, z)]
    return Part.makePolygon(pts + [pts[0]])


def prism_x(yz_pts, x0, length):
    """Extrude a closed (y, z) polygon along +X."""
    pts = [Vector(x0, y, z) for (y, z) in yz_pts]
    face = Part.Face(Part.makePolygon(pts + [pts[0]]))
    return face.extrude(Vector(length, 0, 0))


def fillet_outer_corners(shape):
    edges = []
    for e in shape.Edges:
        if len(e.Vertexes) != 2:
            continue
        a, b = e.Vertexes
        if (abs(a.X - b.X) < 1e-6 and abs(a.Y - b.Y) < 1e-6 and abs(a.Z - b.Z) > 1
                and (abs(a.X) < 1e-6 or abs(a.X - OUTER_W) < 1e-6)
                and (abs(a.Y) < 1e-6 or abs(a.Y - OUTER_H) < 1e-6)):
            edges.append(e)
    return shape.makeFillet(FILLET_R, edges)


# --------------------------------------------------------------------------- #
# Frame
# --------------------------------------------------------------------------- #

def build_frame():
    s = fillet_outer_corners(box(OUTER_W, OUTER_H, DEPTH, 0, 0, 0))
    # window through the face: square land at the screen, then a mat-board
    # bevel opening out toward the front
    s = s.cut(box(win_w, win_h, FACE_T + EPS, win_x0, win_y0, -EPS / 2))
    s = s.cut(Part.makeLoft([rect_wire(win_x0, win_y0, win_w, win_h, bevel_z, 0),
                             rect_wire(win_x0, win_y0, win_w, win_h, 0, bevel_grow),
                             rect_wire(win_x0, win_y0, win_w, win_h, -EPS, bevel_grow)],
                            True, True))
    # device pocket, open at the back
    s = s.cut(box(pocket_w, pocket_h, DEPTH - FACE_T + EPS, pkt_x0, pkt_y0, FACE_T))
    # power-button relief: floor dropped between the two corner pads
    s = s.cut(box(pocket_w - 2 * PAD_W, PAD_RELIEF + EPS, DEPTH - FACE_T + EPS,
                  pkt_x0 + PAD_W, pkt_y0 - PAD_RELIEF, FACE_T))
    # cable slot through the bottom wall, open to the back for lay-in
    s = s.cut(box(USB_W, WALL + 2 * EPS, DEPTH - FACE_T + EPS,
                  usb_x0, -EPS, FACE_T))
    # cleat lip under the top wall: flush with the back, hanging down CLEAT mm
    # at the wall side and tapering to nothing CLEAT mm in front of it. The
    # 45 deg underside prints without support when the frame is face-down.
    lip = prism_x([(pkt_top + EPS, plate_z0), (pkt_top + EPS, DEPTH),
                   (pkt_top - CLEAT, DEPTH), (pkt_top, DEPTH - CLEAT)],
                  pkt_x0 - EPS, pocket_w + 2 * EPS)
    s = s.fuse(lip)
    return s.removeSplitter()


# --------------------------------------------------------------------------- #
# Wall plate
# --------------------------------------------------------------------------- #

plate_w = pocket_w - 2 * PLATE_SIDE_CLR
plate_x0 = pkt_x0 + PLATE_SIDE_CLR
plate_y0 = pkt_top - PLATE_H


def build_plate():
    # Profile in (y, z). Top edge: the front (device side) is the high point and
    # it slopes down toward the wall, leaving a V between plate and wall for the
    # frame's lip. Hung, the frame's top wall rests on the flat tip as well.
    tip_y = pkt_top - PLATE_TIP_FLAT
    s = prism_x([(plate_y0, plate_z0), (plate_y0, DEPTH),
                 (pkt_top - CLEAT, DEPTH),
                 (tip_y, DEPTH - CLEAT + PLATE_TIP_FLAT),
                 (tip_y, plate_z0)],
                plate_x0, plate_w)
    cx = OUTER_W / 2.0
    csk_h = (SCREW_HEAD_D - SCREW_D) / 2.0   # 90 deg countersink
    for x in (cx - SCREW_X, cx + SCREW_X):
        for y in (pkt_top - SCREW_Y_INSET, plate_y0 + SCREW_Y_INSET):
            s = s.cut(Part.makeCylinder(SCREW_D / 2, PLATE_T + 2 * EPS,
                                        Vector(x, y, plate_z0 - EPS)))
            # head sinks in from the device side so it sits flush
            s = s.cut(Part.makeCone(SCREW_HEAD_D / 2 + EPS, SCREW_D / 2,
                                    csk_h + EPS, Vector(x, y, plate_z0 - EPS)))
    return s


def report(name, shape):
    bb = shape.BoundBox
    print("RESULT %-10s solids=%d valid=%s volume=%.1f cm3 bbox %.2f x %.2f x %.2f mm"
          % (name, len(shape.Solids), shape.isValid(), shape.Volume / 1000.0,
             bb.XLength, bb.YLength, bb.ZLength))


def write_stl(shape, path):
    mesh = Mesh.Mesh(shape.tessellate(TESSELLATION))
    mesh.write(path)
    print("STL  %s  %d facets  solid=%s" % (path, mesh.CountFacets, mesh.isSolid()))


try:
    frame = build_frame()
    plate = build_plate()
    report("frame", frame)
    report("wallplate", plate)

    device = box(DEV_W, DEV_H, DEV_D, dev_x0, pkt_y0, FACE_T)  # resting on the pads
    print("CHECK hung: frame/plate overlap %.3f mm3, plate/device overlap %.3f mm3, "
          "frame/device overlap %.3f mm3"
          % (frame.common(plate).Volume, plate.common(device).Volume,
             frame.common(device).Volume))

    write_stl(frame, HERE + "/kindle_frame_slim.stl")
    # Plate goes on the bed wall-side down: flip it so that face is z=0.
    flat = plate.copy()
    flat.rotate(Vector(0, 0, DEPTH / 2.0), Vector(1, 0, 0), 180)
    flat.translate(Vector(-flat.BoundBox.XMin, -flat.BoundBox.YMin, -flat.BoundBox.ZMin))
    write_stl(flat, HERE + "/kindle_frame_slim_wallplate.stl")

    doc = App.newDocument("KindleFrameSlim")
    for nm, shp in (("Frame", frame), ("WallPlate", plate)):
        doc.addObject("Part::Feature", nm).Shape = shp
    doc.recompute()
    Part.export(doc.Objects, HERE + "/kindle_frame_slim.step")
    print("STEP %s/kindle_frame_slim.step" % HERE)

    print("Frame %.2f x %.2f x %.1f mm | window %.1f x %.1f at the screen, "
          "%.1f mm bevel | flat face border: sides %.1f, top %.1f, bottom %.1f"
          % (OUTER_W, OUTER_H, DEPTH, win_w, win_h, bevel_grow,
             win_x0 - bevel_grow, OUTER_H - win_y0 - win_h - bevel_grow,
             win_y0 - bevel_grow))
    print("Wall plate %.2f x %.1f x %.1f mm | plate top edge sits %.1f mm below "
          "the frame's top edge"
          % (plate_w, PLATE_H, PLATE_T, OUTER_H - (pkt_top - PLATE_TIP_FLAT)))
except Exception:
    traceback.print_exc()
