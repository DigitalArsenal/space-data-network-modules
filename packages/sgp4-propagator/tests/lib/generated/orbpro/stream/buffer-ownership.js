var BufferOwnership = /* @__PURE__ */ ((BufferOwnership2) => {
  BufferOwnership2[BufferOwnership2["BORROWED"] = 0] = "BORROWED";
  BufferOwnership2[BufferOwnership2["PRODUCER_OWNED"] = 1] = "PRODUCER_OWNED";
  BufferOwnership2[BufferOwnership2["HOST_OWNED"] = 2] = "HOST_OWNED";
  BufferOwnership2[BufferOwnership2["SHARED"] = 3] = "SHARED";
  return BufferOwnership2;
})(BufferOwnership || {});
export {
  BufferOwnership
};
