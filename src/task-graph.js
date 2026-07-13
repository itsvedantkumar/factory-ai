export function validateGraph(tasks) {
  const ids = new Set(tasks.map((task) => task.id));
  if (ids.size !== tasks.length) throw new Error("Task IDs must be unique");

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      if (dependency === task.id) throw new Error(`Task graph contains a cycle at ${task.id}`);
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  function visit(id) {
    if (visiting.has(id)) throw new Error(`Task graph contains a cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
  return tasks;
}

export function validateDeliveryGraph(tasks) {
  validateGraph(tasks);
  const releaseTasks = tasks.filter((task) => task.role === "release");
  if (releaseTasks.length !== 1) throw new Error("Plan must contain exactly one release task");
  const release = releaseTasks[0];
  if (tasks.some((task) => task.dependsOn.includes(release.id))) {
    throw new Error("Release task must be terminal");
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const ancestors = new Set();
  function collect(id) {
    for (const dependency of byId.get(id).dependsOn) {
      if (!ancestors.has(dependency)) {
        ancestors.add(dependency);
        collect(dependency);
      }
    }
  }
  collect(release.id);
  for (const role of ["tester", "reviewer", "security"]) {
    const gates = tasks.filter((task) => task.role === role);
    if (gates.length === 0) throw new Error(`Plan must contain a ${role} task`);
    if (!gates.some((task) => ancestors.has(task.id))) {
      throw new Error(`Release must have a ${role} ancestor`);
    }
  }
  return tasks;
}

export function readyTasks(tasks, results) {
  return tasks
    .filter((task) => !results[task.id])
    .filter((task) => task.dependsOn.every((id) => results[id]?.status === "succeeded"))
    .map((task) => task.id);
}
