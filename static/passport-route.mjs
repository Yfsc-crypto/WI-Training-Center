// Follow the same section choices in the browser and during server-side grading.
export function quizRoute(course, answers) {
  const pages = course.pages || [{next: -1}];
  const visited = new Set();
  let page = 0;
  while (page !== -1) {
    if (!pages[page] || visited.has(page)) throw Error('เส้นทางของแบบทดสอบวนซ้ำหรือไม่พบส่วนถัดไป');
    visited.add(page);
    let next = pages[page].next;
    if (page < pages.length - 1) {
      course.questions.forEach((q, i) => {
        if ((q.page || 0) !== page || !q.routes || !Array.isArray(answers[i])) return;
        const target = q.routes[answers[i][0]];
        if (Number.isInteger(target)) next = target;
      });
    }
    page = next;
  }
  return visited;
}
