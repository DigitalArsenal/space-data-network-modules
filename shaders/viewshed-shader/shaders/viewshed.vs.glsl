#version 300 es

in vec3 position;

uniform mat4 u_modelView;
uniform mat4 u_viewshedMatrix;
uniform vec3 u_observerPosition;
uniform float u_range;

out vec3 v_positionEC;
out vec4 v_viewshedCoord;
out float v_normalizedDistance;

void main() {
    vec4 localPos = vec4(position, 1.0);

    // Eye-space position via a CPU-composed model-view matrix.
    // Both factors are computed by Cesium in float64, so the resulting
    // matrix has a small (camera-to-observer) translation column and the
    // multiply happens entirely in the small-number regime — no Earth-scale
    // intermediates.
    vec4 positionEC = u_modelView * localPos;

    v_positionEC = positionEC.xyz;
    v_normalizedDistance = length(positionEC.xyz - u_observerPosition) / max(u_range, 1.0);
    v_viewshedCoord = u_viewshedMatrix * positionEC;

    // Use Cesium's RTE projection for gl_Position so depth values match
    // every other draw call in the scene (translucent sort stays stable).
    gl_Position = czm_modelViewProjectionRelativeToEye * localPos;
}
