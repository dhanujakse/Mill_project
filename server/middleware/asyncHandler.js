// Express 4 does not catch a rejected promise from an async route handler, so
// any unexpected throw inside one (e.g. calling .trim() on a non-string body
// value) becomes an unhandled rejection and Node exits, taking the whole API
// down. Forwarding it to next() hands it to the error middleware in index.js.
export const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};
