"""Local chemistry-renderer arrow geometry, following the supplied reference."""
from html import escape
HEAD_LENGTH=7.2
HEAD_HALF_HEIGHT=2.35
HEAD_NOTCH=1.45
SHAFT_WIDTH=0.8
HALF_HEAD_HEIGHT=2.35
EQUILIBRIUM_GAP=3.2
STYLE_VERSION='reaction-guide-v3-compact-filled-arrows'
_kind='forward'

def set_kind(kind='forward'):
    global _kind
    assert kind in ['forward','equilibrium']
    _kind=kind

def graphics(x1,y,x2,kind='forward'):
    def path(d,cls,fill='none',stroke='#000',width=SHAFT_WIDTH):
        return f'<path d="{d}" class="{cls}" style="fill:{fill};stroke:{stroke};stroke-width:{width};stroke-linecap:butt;stroke-linejoin:miter"/>'
    h=HEAD_LENGTH;v=HEAD_HALF_HEIGHT;n=HEAD_NOTCH
    if kind=='equilibrium':
        a=y-EQUILIBRIUM_GAP/2;b=y+EQUILIBRIUM_GAP/2
        return '\n'.join([
          path(f'M {x1+1.8} {a} L {x2-h+n} {a}','rxnArrow equilibriumShaft'),
          path(f'M {x2} {a} L {x2-h} {a-v} L {x2-h+n} {a} Z','compactArrowHead equilibriumHead','#000','none',0),
          path(f'M {x2-1.8} {b} L {x1+h-n} {b}','rxnArrow equilibriumShaft'),
          path(f'M {x1} {b} L {x1+h} {b+v} L {x1+h-n} {b} Z','compactArrowHead equilibriumHead','#000','none',0)])
    return '\n'.join([
      path(f'M {x1} {y} L {x2-h+n} {y}','rxnArrow'),
      path(f'M {x2} {y} L {x2-h} {y-v} L {x2-h+n} {y} L {x2-h} {y+v} Z','compactArrowHead','#000','none',0)])

def native_arrow(x1,y,x2,label='',sublabel=''):
    mid=(x1+x2)/2
    return (graphics(x1,y,x2,_kind)+'\n'
      +f'<text x="{mid}" y="{y-14}" class="arrowLabel" text-anchor="middle">{escape(label)}</text>\n'
      +f'<text x="{mid}" y="{y+24}" class="arrowLabel" text-anchor="middle">{escape(sublabel)}</text>\n')

def install(style):
    # Keep the existing measured-condition compositor and chemistry geometry.
    style._arrow=native_arrow
