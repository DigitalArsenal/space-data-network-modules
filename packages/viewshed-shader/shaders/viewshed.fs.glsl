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

in vec3 v_positionWC;
in vec4 v_viewshedCoord;
in float v_normalizedDistance;

uniform vec4 u_visibleColor;
uniform vec4 u_occludedColor;
uniform float u_opacity;
uniform sampler2D u_viewshedTexture;
uniform vec3 u_observerPosition;
uniform float u_range;

out vec4 out_FragColor;

// Bias to avoid shadow acne (self-shadowing) on surfaces facing the observer
const float SHADOW_BIAS = 0.001;

bool isBeyondRange() {
    return v_normalizedDistance > 1.0;
}

bool isVisible() {
    // Perspective divide to get normalized device coordinates in observer space
    vec3 ndc = v_viewshedCoord.xyz / v_viewshedCoord.w;

    // Map from NDC [-1,1] to texture UV [0,1]
    vec2 uv = ndc.xy * 0.5 + 0.5;

    // Clamp: anything outside the viewshed frustum is considered occluded
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || v_viewshedCoord.w <= 0.0) {
        return false;
    }

    // Depth of this fragment from the observer's perspective
    float fragmentDepth = ndc.z * 0.5 + 0.5;

    // Depth stored in the viewshed shadow map (closest occluder from observer)
    float shadowMapDepth = texture(u_viewshedTexture, uv).r;

    // Fragment is visible if it is at or closer than the nearest occluder
    return (fragmentDepth - SHADOW_BIAS) <= shadowMapDepth;
}

void main() {
    // Skip pixels beyond the viewshed range
    if (isBeyondRange()) {
        discard;
    }

    vec4 color = isVisible() ? u_visibleColor : u_occludedColor;
    color.a *= u_opacity;

    if (color.a <= 0.0) {
        discard;
    }

    out_FragColor = color;
}
