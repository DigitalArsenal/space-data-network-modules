#version 300 es

in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 normal;
in vec2 st;
in float batchId;
uniform vec3 u_sensorVertex;

out vec3 v_positionWC;
out vec3 v_positionEC;
out vec3 v_normalEC;
out vec2 v_st;

void main()
{
    vec4 position = czm_computePosition();

    gl_Position = czm_modelViewProjectionRelativeToEye * position;
    gl_Position.z -= 0.00001 * gl_Position.w; 

    vec4 high = vec4(position3DHigh, 1.0);
    vec4 low = vec4(position3DLow, 0.0);

    v_positionWC =  ( high + low).xyz ;

    v_positionEC = (czm_modelViewRelativeToEye * position).xyz;
    v_normalEC = czm_normal * normal;
    v_st = st;
}