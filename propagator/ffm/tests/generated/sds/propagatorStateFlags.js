export var propagatorStateFlags = /*#__PURE__*/ function(propagatorStateFlags) {
    propagatorStateFlags[propagatorStateFlags["VALID"] = 1] = "VALID";
    propagatorStateFlags[propagatorStateFlags["IN_ECLIPSE"] = 2] = "IN_ECLIPSE";
    propagatorStateFlags[propagatorStateFlags["DECAYED"] = 4] = "DECAYED";
    propagatorStateFlags[propagatorStateFlags["EXTRAPOLATED"] = 8] = "EXTRAPOLATED";
    propagatorStateFlags[propagatorStateFlags["RESERVED_4"] = 16] = "RESERVED_4";
    propagatorStateFlags[propagatorStateFlags["RESERVED_5"] = 32] = "RESERVED_5";
    propagatorStateFlags[propagatorStateFlags["RESERVED_6"] = 64] = "RESERVED_6";
    propagatorStateFlags[propagatorStateFlags["RESERVED_7"] = 128] = "RESERVED_7";
    return propagatorStateFlags;
}({});
