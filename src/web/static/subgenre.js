// New-project form: show only the subgenres of the chosen genre. Without this script the full list is offered and the
// server still refuses a pair the catalogue does not know (progressive enhancement, nothing depends on it).
(function () {
  var genre = document.getElementById("genre");
  var sub = document.getElementById("subgenre");
  if (!genre || !sub) return;
  function narrow() {
    var g = genre.value;
    var keep = null;
    for (var i = 0; i < sub.options.length; i++) {
      var o = sub.options[i];
      var own = o.getAttribute("data-genre");
      var show = !own || own === g;
      o.hidden = !show;
      o.disabled = !show;
      if (show && o.selected) keep = o;
    }
    if (!keep) sub.value = "";
  }
  genre.addEventListener("change", narrow);
  narrow();
})();
