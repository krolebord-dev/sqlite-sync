const key = 'last-opened-list';

function getLastOpenedList() {
  return localStorage.getItem(key);
}

function setLastOpenedList(listId: string) {
  localStorage.setItem(key, listId);
}

export const lastOpenedList = {
  get: getLastOpenedList,
  set: setLastOpenedList,
};
