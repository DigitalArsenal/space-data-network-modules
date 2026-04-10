#version 300 es

#ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    precision highp int;
#else
    precision mediump float;
    precision mediump int;
    #define highp mediump
#endif

uniform vec4 u_intersectionColor;
uniform float u_intersectionWidth;
uniform bool u_showIntersection;
uniform bool u_showThroughEllipsoid;
uniform float u_sensorRadius;
uniform float u_normalDirection;
uniform vec3 u_sensorVertex;

in vec3 v_positionEC;
in vec3 v_positionWC;
in vec3 v_normalEC;
in vec2 v_st;

float ellipsoidSurfaceFunction(vec3 point)
{
    vec3 scaled = czm_ellipsoidInverseRadii * point;
    return dot(scaled, scaled) - 1.0;
}

bool inSensorShadow(vec3 sensorVertexWC, vec3 pointWC)
{
    vec3 D = czm_ellipsoidInverseRadii;
    vec3 q = D * sensorVertexWC;
    float qMagnitudeSquared = dot(q, q);
    float test = qMagnitudeSquared - 1.0;
    vec3 temp = D * pointWC - q;
    float d = dot(temp, q);
    return (d < -test) && (d / length(temp) < -sqrt(test));
}

vec4 getIntersectionColor()
{
    return u_intersectionColor;
}

float getIntersectionWidth()
{
    return u_intersectionWidth;
}

vec4 shade(bool isOnBoundary, vec4 outFragColor)
{
    if (u_showIntersection && isOnBoundary)
    {
        return getIntersectionColor();
    }
    return outFragColor;
}


bool isOnBoundary(float value, float epsilon)
{
    float width = getIntersectionWidth();
    float tolerance = width * epsilon;
    float delta = max(abs(dFdx(value)), abs(dFdy(value)));
    float pixels = width * delta;
    float temp = abs(value);
    return temp < tolerance && temp < pixels || (delta < 10.0 * tolerance && temp - delta < tolerance && temp < pixels);
}

void main()
{
    vec3 positionToEyeEC = -v_positionEC;
    float ellipsoidValue = ellipsoidSurfaceFunction(v_positionWC);

    vec3 normalEC = normalize(v_normalEC);
    #ifdef FACE_FORWARD
        normalEC = faceforward(normalEC, vec3(0.0, 0.0, 1.0), -normalEC);
    #endif

    czm_materialInput materialInput;
    materialInput.normalEC = normalEC;
    materialInput.positionToEyeEC = positionToEyeEC;
    materialInput.st = v_st;
    czm_material material = czm_getMaterial(materialInput);
    vec3 sensorVertexWC = czm_model[3].xyz;  
    vec3 sensorVertexEC = (czm_modelView * vec4(sensorVertexWC, 1.0)).xyz;

    if(czm_sceneMode == czm_sceneMode3D){
        if (!u_showThroughEllipsoid)
        {
            if (ellipsoidValue < 0.0)
            {
                discard;
            }

            if (inSensorShadow(u_sensorVertex, v_positionWC))
            {
                discard;
            }
        }
    }
    if (distance(v_positionEC, sensorVertexEC) > u_sensorRadius)
    {
      //  discard;
    }

    bool isOnEllipsoid = czm_sceneMode == czm_sceneMode3D ? isOnBoundary(ellipsoidValue, czm_epsilon3): false;
    
    #ifdef FLAT
        out_FragColor = vec4(material.diffuse + material.emission, material.alpha);
    #else
        out_FragColor = czm_phong(normalize(positionToEyeEC), material, czm_lightDirectionEC);
    #endif
    out_FragColor = shade(isOnEllipsoid, out_FragColor);
}