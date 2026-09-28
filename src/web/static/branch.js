(function () {
  var form = document.querySelector(".branch-form");
  var body = document.getElementById("branch-body");
  if (!form || !body) return;
  var select = form.querySelector("select");
  select.addEventListener("change", function () {
    var base = form.getAttribute("data-partial");
    var name = select.value;
    fetch(base + "?partial=1&branch=" + encodeURIComponent(name), { credentials: "same-origin", headers: { accept: "text/html" } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then(function (text) {
        body.innerHTML = text;
        history.replaceState(null, "", base + "?branch=" + encodeURIComponent(name));
        document.dispatchEvent(new CustomEvent("branch-changed"));
      })
      .catch(function () { form.submit(); });
  });
})();
