// Throwaway sample used to exercise ReviewPilot end-to-end on a real PR.
// Intentionally contains a couple of reviewable issues. Not part of the build.

export function parsePort(input) {
  const port = parseInt(input); // no radix; no NaN guard
  return port || 3000; // turns an explicit port 0 into 3000
}

export async function fetchUser(id) {
  const res = await fetch("https://api.example.com/users/" + id);
  const data = await res.json(); // no res.ok check; no error handling
  return data.name;
}
