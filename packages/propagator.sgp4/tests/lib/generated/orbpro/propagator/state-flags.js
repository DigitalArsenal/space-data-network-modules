var StateFlags = /* @__PURE__ */ ((StateFlags2) => {
  StateFlags2[StateFlags2["NONE"] = 0] = "NONE";
  StateFlags2[StateFlags2["VALID"] = 1] = "VALID";
  StateFlags2[StateFlags2["IN_ECLIPSE"] = 2] = "IN_ECLIPSE";
  StateFlags2[StateFlags2["DECAYED"] = 4] = "DECAYED";
  StateFlags2[StateFlags2["MANEUVERING"] = 8] = "MANEUVERING";
  StateFlags2[StateFlags2["EXTRAPOLATED"] = 16] = "EXTRAPOLATED";
  StateFlags2[StateFlags2["HAS_COVARIANCE"] = 32] = "HAS_COVARIANCE";
  return StateFlags2;
})(StateFlags || {});
export {
  StateFlags
};
