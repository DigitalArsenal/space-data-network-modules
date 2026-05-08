#version 300 es

#ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    precision highp int;
    precision highp sampler2D;
#else
    precision mediump float;
    precision mediump int;
    precision mediump sampler2D;
    #define highp mediump
#endif

in vec3 v_positionEC;
in vec4 v_viewshedCoord;
in float v_normalizedDistance;

uniform vec4 u_visibleColor;
uniform vec4 u_occludedColor;
uniform float u_opacity;
uniform sampler2D u_viewshedTexture;

out vec4 out_FragColor;

void main() {
    if (v_normalizedDistance > 1.0) {
        discard;
    }

    vec3 ndc = v_viewshedCoord.xyz / v_viewshedCoord.w;
    vec2 uv  = ndc.xy * 0.5 + 0.5;

    bool inside = (v_viewshedCoord.w > 0.0) &&
                  all(greaterThanEqual(uv, vec2(0.0))) &&
                  all(lessThanEqual(uv, vec2(1.0)));

    bool visible = false;
    if (inside) {
        float fragmentDepth = ndc.z * 0.5 + 0.5;
        float shadowMapDepth = texture(u_viewshedTexture, uv).r;

        // Range-scaled bias avoids self-shadowing acne at long ranges where
        // a fixed NDC bias under-compensates for shadow-map texel quantization.
        float bias = max(1e-5, 5e-6 * v_normalizedDistance);
        visible = (fragmentDepth - bias) <= shadowMapDepth;
    }

    vec4 color = visible ? u_visibleColor : u_occludedColor;
    color.a *= u_opacity;

    if (color.a <= 0.0) {
        discard;
    }

    out_FragColor = color;
}
