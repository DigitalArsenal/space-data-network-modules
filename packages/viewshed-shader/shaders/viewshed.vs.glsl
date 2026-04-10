#version 300 es

in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec2 st;
in float batchId;

uniform mat4 u_modelViewProjection;
uniform vec3 u_observerPosition;
uniform float u_range;
uniform mat4 u_viewshedMatrix;

out vec3 v_positionWC;
out vec4 v_viewshedCoord;
out float v_normalizedDistance;

void main() {
    vec4 position = czm_computePosition();

    // World-space position
    vec4 high = vec4(position3DHigh, 1.0);
    vec4 low = vec4(position3DLow, 0.0);
    v_positionWC = (high + low).xyz;

    // Distance from observer, normalized to [0,1] over the viewshed range
    vec3 toPoint = v_positionWC - u_observerPosition;
    v_normalizedDistance = length(toPoint) / max(u_range, 1.0);

    // Project into the observer's shadow-map clip space for depth comparison
    v_viewshedCoord = u_viewshedMatrix * vec4(v_positionWC, 1.0);

    gl_Position = czm_modelViewProjectionRelativeToEye * position;
}
