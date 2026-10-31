# Механик пит-стопа для f1-race (Рома 31.10: «анимация механиков на пит-стопе»). Запуск без окна:
#   blender -b -P tools/model/make_crew.py -- public/models/crew.glb
# Части с суставами (начало каждой — в суставе, дети висят на родителях): mech_body (таз, торс, шлем) →
# mech_upperarm_L/R → mech_forearm_L/R (с перчаткой); mech_thigh_L/R → mech_shin_L/R (с ботинком). Инструменты отдельно:
# tool_gun (гайковёрт, начало — в рукоятке), tool_jack (передний/задний домкрат, начало — в ручке), tool_sign (табличка
# выпуска, начало — низ шеста). Механик смотрит в −Y Блендера = +Z three.js. Материалы: suit (перекрашивается в цвет
# команды), suit_dark (перчатки, ботинки, вставки), helmet, visor, tool, metal, sign.
import bpy, bmesh, sys
from mathutils import Vector, Matrix
from math import radians

out = sys.argv[sys.argv.index('--') + 1] if '--' in sys.argv else 'crew.glb'
bpy.ops.wm.read_factory_settings(use_empty=True)

MATS = {}
def mat(name, rgb, rough=0.6, metal=0.0):
    if name in MATS: return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*rgb, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    MATS[name] = m
    return m

SUIT = mat('suit', (0.92, 0.92, 0.92), 0.75)
DARK = mat('suit_dark', (0.05, 0.05, 0.06), 0.8)
HELM = mat('helmet', (0.85, 0.85, 0.86), 0.3)
VISOR = mat('visor', (0.02, 0.02, 0.03), 0.08, 0.3)
TOOL = mat('tool', (0.12, 0.12, 0.13), 0.45, 0.2)
METAL = mat('metal', (0.7, 0.71, 0.73), 0.3, 1.0)
SIGN = mat('sign', (0.95, 0.95, 0.95), 0.6)

def finish(o, m):
    o.data.materials.append(m)
    for p in o.data.polygons: p.use_smooth = True
    return o

def sphere(loc, scale, m, seg=16, rings=10):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, location=loc)
    o = bpy.context.object
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    return finish(o, m)

def cyl(a, b, r1, r2, m, seg=14):
    a, b = Vector(a), Vector(b)
    d = b - a
    bpy.ops.mesh.primitive_cone_add(vertices=seg, radius1=r1, radius2=r2, depth=d.length, location=(a + b) / 2)
    o = bpy.context.object
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    bpy.ops.object.transform_apply(rotation=True)
    return finish(o, m)

def box(loc, size, m, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.object
    o.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        mod = o.modifiers.new('b', 'BEVEL'); mod.width = bevel; mod.segments = 2
        bpy.ops.object.modifier_apply(modifier='b')
    return finish(o, m)

def join(objs, name, origin):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.object
    o.name = name
    o.data.name = name
    # начало — в суставе
    bpy.context.scene.cursor.location = origin
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    return o

def parent(child, par):
    m = child.matrix_world.copy()
    child.parent = par
    child.matrix_world = m

# ---- тело: таз, живот, грудь, плечи, шея, шлем ----
HIP = Vector((0, 0, 0.95))
parts = [
    sphere((0, 0, 0.98), (0.17, 0.12, 0.12), SUIT),
    sphere((0, 0, 1.12), (0.165, 0.115, 0.17), SUIT),
    sphere((0, 0.0, 1.3), (0.2, 0.125, 0.16), SUIT),
    sphere((0.2, 0, 1.4), (0.075, 0.075, 0.07), SUIT),
    sphere((-0.2, 0, 1.4), (0.075, 0.075, 0.07), SUIT),
    cyl((0, 0, 1.42), (0, 0, 1.55), 0.06, 0.055, DARK),
    sphere((0, 0, 1.66), (0.14, 0.15, 0.15), HELM, 20, 14),
    sphere((0, -0.105, 1.655), (0.11, 0.06, 0.055), VISOR, 18, 10),
    # полоса на шлеме и пояс, тёмные вставки по бокам комбинезона
    sphere((0, 0.0, 1.72), (0.142, 0.152, 0.03), DARK, 20, 6),
    cyl((0, 0, 0.96), (0, 0, 1.0), 0.172, 0.172, DARK, 20),
    sphere((0.17, 0, 1.15), (0.02, 0.1, 0.14), DARK),
    sphere((-0.17, 0, 1.15), (0.02, 0.1, 0.14), DARK),
]
body = join(parts, 'mech_body', HIP)

def arm(side):
    sx = 1 if side == 'L' else -1  # левая рука — +X (механик смотрит в −Y)
    sh = Vector((0.22 * sx, 0, 1.4))
    el = sh + Vector((0.02 * sx, 0, -0.29))
    wr = el + Vector((0, -0.02, -0.26))
    up = join([cyl(sh, el, 0.06, 0.05, SUIT), sphere(sh, (0.065, 0.065, 0.065), SUIT)], 'mech_upperarm_' + side, sh)
    fo = join([cyl(el, wr, 0.05, 0.042, SUIT), sphere(el, (0.05, 0.05, 0.05), SUIT),
               cyl(wr + Vector((0, 0, 0.05)), wr, 0.046, 0.046, DARK),
               sphere(wr + Vector((0, -0.01, -0.05)), (0.045, 0.05, 0.065), DARK)], 'mech_forearm_' + side, el)
    parent(fo, up)
    parent(up, body)

def leg(side):
    sx = 1 if side == 'L' else -1
    hp = Vector((0.095 * sx, 0, 0.97))
    kn = Vector((0.1 * sx, 0, 0.5))
    an = Vector((0.1 * sx, 0.01, 0.09))
    th = join([cyl(hp, kn, 0.085, 0.065, SUIT), sphere(hp, (0.085, 0.085, 0.085), SUIT)], 'mech_thigh_' + side, hp)
    sh = join([cyl(kn, an, 0.064, 0.05, SUIT), sphere(kn, (0.066, 0.066, 0.066), SUIT),
               sphere(an + Vector((0, -0.06, -0.035)), (0.06, 0.13, 0.055), DARK),
               cyl(an + Vector((0, 0, 0.09)), an, 0.054, 0.056, DARK)], 'mech_shin_' + side, kn)
    parent(sh, th)
    parent(th, body)

for s in ('L', 'R'):
    arm(s)
    leg(s)

# ---- инструменты (стоят в стороне, в игре их берут в руки) ----
O = Vector((2, 0, 0))
g = [box(O + Vector((0, -0.02, 0)), (0.05, 0.05, 0.13), TOOL, 0.01),  # рукоятка
     cyl(O + Vector((0, 0.06, 0.08)), O + Vector((0, -0.17, 0.08)), 0.055, 0.05, TOOL),  # корпус
     cyl(O + Vector((0, -0.17, 0.08)), O + Vector((0, -0.26, 0.08)), 0.034, 0.034, METAL),  # головка на гайку
     cyl(O + Vector((0, 0.06, 0.08)), O + Vector((0, 0.1, 0.08)), 0.045, 0.03, DARK),
     cyl(O + Vector((0, 0.1, 0.08)), O + Vector((0, 0.35, -0.1)), 0.015, 0.015, DARK, 8)]  # шланг
join(g, 'tool_gun', O)

J = Vector((4, 0, 0.9))
j = [cyl(J, J + Vector((0, -1.25, -0.72)), 0.025, 0.025, TOOL, 10),  # рукоять под углом
     box(J + Vector((0, -1.3, -0.78)), (0.5, 0.18, 0.08), TOOL, 0.015),  # опора под носом
     box(J + Vector((0, -1.25, -0.84)), (0.08, 0.3, 0.06), METAL, 0.01),
     cyl(J + Vector((0.18, -1.2, -0.84)), J + Vector((0.24, -1.2, -0.84)), 0.05, 0.05, DARK, 12),
     cyl(J + Vector((-0.18, -1.2, -0.84)), J + Vector((-0.24, -1.2, -0.84)), 0.05, 0.05, DARK, 12),
     cyl(J + Vector((-0.12, 0, 0)), J + Vector((0.12, 0, 0)), 0.022, 0.022, DARK, 10)]  # поперечная ручка
join(j, 'tool_jack', J)

S = Vector((6, 0, 0))
s = [cyl(S, S + Vector((0, 0, 1.25)), 0.016, 0.016, TOOL, 8),
     cyl(S + Vector((0, 0.012, 1.42)), S + Vector((0, -0.012, 1.42)), 0.2, 0.2, SIGN, 24),
     cyl(S + Vector((0, 0.014, 1.42)), S + Vector((0, -0.014, 1.42)), 0.205, 0.205, DARK, 24)]
join(s, 'tool_sign', S)

# повернуть стоящие на месте механики/инструменты нечем — экспорт как есть (+Y вверх, механик смотрит в +Z)
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_yup=True, export_apply=True)
print('ok', out)
