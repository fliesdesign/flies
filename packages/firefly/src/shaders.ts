export const vertex = `#version 300 es
precision highp float;
uniform mat3 uMatrix;
uniform vec2 uViewport;
uniform vec2 uPadding;
out vec2 vUv;
const vec2 corners[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
void main() {
  vUv = corners[gl_VertexID] * (1.0 + 2.0*uPadding) - uPadding;
  vec2 p = (uMatrix * vec3(vUv,1)).xy;
  gl_Position = vec4(p / uViewport * vec2(2,-2) + vec2(-1,1),0,1);
}`;

export const fragment = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outputColor;
uniform sampler2D uTexture;
uniform sampler2D uBackdrop;
uniform vec4 uColor;
uniform vec2 uSize;
uniform float uRadius;
uniform float uOpacity;
uniform int uMode;
uniform bool uFlip;
uniform bool uTextureEdges;
uniform int uBlend;
uniform int uFilter;
uniform float uAmount;
uniform vec2 uBlurStep;
vec4 source(vec2 uv) { return texture(uTexture, vec2(uv.x,uFlip ? 1.0-uv.y : uv.y)); }
float lum(vec3 c) { return dot(c,vec3(.3,.59,.11)); }
float sat(vec3 c) { return max(max(c.r,c.g),c.b)-min(min(c.r,c.g),c.b); }
vec3 clipColor(vec3 c) {
  float l=lum(c), n=min(min(c.r,c.g),c.b), x=max(max(c.r,c.g),c.b);
  if(n<0.0) c=l+(c-l)*l/max(l-n,.00001);
  if(x>1.0) c=l+(c-l)*(1.0-l)/max(x-l,.00001);
  return c;
}
vec3 setLum(vec3 c,float l) { return clipColor(c+l-lum(c)); }
vec3 setSat(vec3 c,float s) {
  float lo=min(min(c.r,c.g),c.b), hi=max(max(c.r,c.g),c.b);
  return hi>lo ? (c-lo)*s/(hi-lo) : vec3(0);
}
vec3 blend(vec3 b,vec3 s) {
  if(uBlend==1) return b*s;
  if(uBlend==2) return b+s-b*s;
  if(uBlend==3) return mix(2.0*b*s,1.0-2.0*(1.0-b)*(1.0-s),step(.5,b));
  if(uBlend==4) return min(b,s);
  if(uBlend==5) return max(b,s);
  if(uBlend==6) return mix(min(vec3(1),b/max(vec3(.00001),1.0-s)),vec3(0),step(b,vec3(0)));
  if(uBlend==7) return mix(1.0-min(vec3(1),(1.0-b)/max(s,vec3(.00001))),vec3(1),step(vec3(1),b));
  if(uBlend==8) return mix(2.0*b*s,1.0-2.0*(1.0-b)*(1.0-s),step(.5,s));
  if(uBlend==9) {
    vec3 d=mix(((16.0*b-12.0)*b+4.0)*b,sqrt(b),step(.25,b));
    return mix(b-(1.0-2.0*s)*b*(1.0-b),b+(2.0*s-1.0)*(d-b),step(.5,s));
  }
  if(uBlend==10) return abs(b-s);
  if(uBlend==11) return b+s-2.0*b*s;
  if(uBlend==12) return setLum(setSat(s,sat(b)),lum(b));
  if(uBlend==13) return setLum(setSat(b,sat(s)),lum(b));
  if(uBlend==14) return setLum(s,lum(b));
  if(uBlend==15) return setLum(b,lum(s));
  return s;
}
vec3 colorFilter(vec3 c) {
  float a=uAmount;
  if(uFilter==1) return c*a;
  if(uFilter==2) return (c-.5)*a+.5;
  if(uFilter==3 || uFilter==4) {
    float s=uFilter==4 ? 1.0-a : a;
    return mix(vec3(dot(c,vec3(.2126,.7152,.0722))),c,s);
  }
  if(uFilter==5) return mix(c,vec3(dot(c,vec3(.393,.769,.189)),dot(c,vec3(.349,.686,.168)),dot(c,vec3(.272,.534,.131))),a);
  if(uFilter==6) return mix(c,1.0-c,a);
  if(uFilter==7) {
    float co=cos(radians(a)),si=sin(radians(a));
    return vec3(
      dot(c,vec3(.213+.787*co-.213*si,.715-.715*co-.715*si,.072-.072*co+.928*si)),
      dot(c,vec3(.213-.213*co+.143*si,.715+.285*co+.140*si,.072-.072*co-.283*si)),
      dot(c,vec3(.213-.213*co-.787*si,.715-.715*co+.715*si,.072+.928*co+.072*si)));
  }
  return c;
}
void main() {
  vec4 color;
  if(uMode==0) {
    vec2 p=abs((vUv-.5)*uSize)-uSize*.5+uRadius;
    float d=length(max(p,vec2(0)))+min(max(p.x,p.y),0.0)-uRadius;
    float aa=max(fwidth(d),.0001);
    float coverage=1.0-smoothstep(-aa*.5,aa*.5,d);
    if(coverage<=0.0) discard;
    color=vec4(uColor.rgb*uColor.a,uColor.a)*coverage;
  } else {
    color=source(vUv);
    if(uFilter==8) {
      color=vec4(0); float total=0.0;
      for(int i=-24;i<=24;i++) {
        float x=float(i)/8.0, weight=exp(-.5*x*x);
        vec2 uv=vUv+float(i)*uBlurStep;
        if(all(greaterThanEqual(uv,vec2(0))) && all(lessThanEqual(uv,vec2(1)))) color+=source(uv)*weight;
        total+=weight;
      }
      color/=total;
    } else if(uFilter>0 && color.a>0.0) color.rgb=clamp(colorFilter(color.rgb/color.a),0.0,1.0)*color.a;
  }
  if(uMode==1 && uTextureEdges) {
    vec2 p=abs((vUv-.5)*uSize)-uSize*.5;
    float d=max(p.x,p.y), aa=max(fwidth(d),.0001);
    color*=1.0-smoothstep(-aa*.5,aa*.5,d);
  }
  color*=uOpacity;
  if(uBlend>0) {
    vec4 backdrop=texture(uBackdrop,gl_FragCoord.xy/vec2(textureSize(uBackdrop,0)));
    vec3 b=backdrop.a>0.0 ? backdrop.rgb/backdrop.a : vec3(0);
    vec3 s=color.a>0.0 ? color.rgb/color.a : vec3(0);
    color.rgb=color.rgb*(1.0-backdrop.a)+blend(b,s)*color.a*backdrop.a;
  }
  outputColor=color;
}`;
