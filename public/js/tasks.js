(function () {
  const post = (url, data) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }).then(r => r.json());

  document.querySelectorAll('.kcard').forEach(card => {
    card.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', card.dataset.id); card.classList.add('dragging'); });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  document.querySelectorAll('.kanban-cards').forEach(col => {
    col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('dragover'));
    col.addEventListener('drop', async e => {
      e.preventDefault(); col.classList.remove('dragover');
      const id = e.dataTransfer.getData('text/plain');
      const j = await post('/tasks/' + id + '/update', { status: col.dataset.status });
      if (j.ok) location.reload(); else alert(j.error || 'Failed');
    });
  });

  document.querySelectorAll('.kdel').forEach(btn => btn.addEventListener('click', async e => {
    const card = e.target.closest('.kcard');
    if (!confirm('Delete this task?')) return;
    const j = await post('/tasks/' + card.dataset.id + '/delete', {});
    if (j.ok) card.remove(); else alert(j.error || 'Failed');
  }));

  document.querySelectorAll('.addsub').forEach(btn => btn.addEventListener('click', async () => {
    const title = prompt('Subtask title:');
    if (!title) return;
    const j = await post('/tasks/create', { title, parent_id: btn.dataset.id });
    if (j.ok) location.reload(); else alert(j.error || 'Failed');
  }));

  document.querySelectorAll('.subchk').forEach(chk => chk.addEventListener('change', async e => {
    const li = e.target.closest('li');
    await post('/tasks/' + li.dataset.id + '/update', { status: e.target.checked ? 'done' : 'todo' });
    li.classList.toggle('sub-done', e.target.checked);
  }));

  const form = document.getElementById('new-task-form');
  if (form) form.addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    const j = await post('/tasks/create', data);
    if (j.ok) location.reload(); else alert(j.error || 'Failed');
  });

  const modal = document.getElementById('new-task-modal');
  const editModal = document.getElementById('edit-task-modal');
  [modal, editModal].forEach(m => {
    if (m) m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (modal) modal.classList.add('hidden'); if (editModal) editModal.classList.add('hidden'); }
  });

  // inline status change (no drag needed)
  document.querySelectorAll('.kstatus').forEach(sel => {
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', async () => {
      const j = await post('/tasks/' + sel.dataset.id + '/update', { status: sel.value });
      if (j.ok) location.reload(); else alert(j.error || 'Failed');
    });
  });

  // click a card to view/edit
  const $ = id => document.getElementById(id);
  document.querySelectorAll('.kcard[data-task]').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('button, select, input, a, .subtasks')) return;
      let t;
      try { t = JSON.parse(card.dataset.task); } catch (_) { return; }
      $('e-id').value = t.id;
      $('e-title').value = t.title || '';
      $('e-description').value = t.description || '';
      $('e-status').value = t.status || 'todo';
      $('e-priority').value = t.priority || 'medium';
      $('e-assigned').value = t.assigned_to || '';
      if (!$('e-assigned').value) $('e-assigned').selectedIndex = 0;
      $('e-list').value = t.list_id || '';
      $('e-date').value = t.due_date || '';
      $('e-time').value = t.due_time || '';
      $('e-labels').value = (t.labels || []).join(', ');
      editModal.classList.remove('hidden');
    });
  });

  const editForm = document.getElementById('edit-task-form');
  if (editForm) editForm.addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(editForm).entries());
    const id = data.id; delete data.id;
    const j = await post('/tasks/' + id + '/update', data);
    if (j.ok) location.reload(); else alert(j.error || 'Failed');
  });

  const delBtn = document.getElementById('e-delete');
  if (delBtn) delBtn.addEventListener('click', async () => {
    if (!confirm('Delete this task?')) return;
    const j = await post('/tasks/' + $('e-id').value + '/delete', {});
    if (j.ok) location.reload(); else alert(j.error || 'Failed');
  });
})();
