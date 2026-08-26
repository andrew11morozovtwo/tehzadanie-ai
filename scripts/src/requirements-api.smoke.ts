import assert from "node:assert/strict";

const baseUrl = process.env.REQUIREMENTS_API_URL ?? "http://localhost:80";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const email = `smoke-${suffix}@example.test`;

const register = await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Smoke Test", email }),
});

assert.equal(register.status, 201, "Registration must create a user");
const cookie = register.headers.get("set-cookie");
assert.ok(cookie, "Registration must issue a session cookie");
const registration = (await register.json()) as { password?: string; user?: { email?: string } };
assert.equal(registration.user?.email, email);
assert.ok(registration.password, "Registration must return a generated password");

const session = await fetch(`${baseUrl}/api/sessions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: cookie,
  },
  body: JSON.stringify({ title: "Проверка основного сценария" }),
});

assert.equal(session.status, 201, "Authenticated user must be able to create a project");
const project = (await session.json()) as { id?: number; title?: string };
assert.ok(project.id, "Created project must have an ID");
assert.equal(project.title, "Проверка основного сценария");

const formData = new FormData();
formData.set("file", new Blob(["Референс для smoke-проверки"], { type: "text/plain" }), "reference.txt");
const uploaded = await fetch(`${baseUrl}/api/sessions/${project.id}/files`, {
  method: "POST",
  headers: { Cookie: cookie },
  body: formData,
});
assert.equal(uploaded.status, 201, "Authenticated user must be able to attach a reference");
const reference = (await uploaded.json()) as { id?: number; name?: string };
assert.ok(reference.id, "Uploaded reference must have an ID");
assert.equal(reference.name, "reference.txt");

console.log("Requirements API smoke test passed.");