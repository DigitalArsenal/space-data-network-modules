export var operationalState = /*#__PURE__*/ function(operationalState) {
    operationalState[operationalState["OPERATIONAL"] = 0] = "OPERATIONAL";
    operationalState[operationalState["NONOPERATIONAL"] = 1] = "NONOPERATIONAL";
    operationalState[operationalState["PARTIALLY_OPERATIONAL"] = 2] = "PARTIALLY_OPERATIONAL";
    operationalState[operationalState["BACKUP_STANDBY"] = 3] = "BACKUP_STANDBY";
    operationalState[operationalState["SPARE"] = 4] = "SPARE";
    operationalState[operationalState["EXTENDED_MISSION"] = 5] = "EXTENDED_MISSION";
    operationalState[operationalState["DECAYED"] = 6] = "DECAYED";
    operationalState[operationalState["UNKNOWN"] = 7] = "UNKNOWN";
    return operationalState;
}({});
