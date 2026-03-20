(function () {
  // --- Dropdown (Practice Plans) ---
  var dropdown = document.querySelector('.nav-dropdown');
  var trigger = dropdown && dropdown.querySelector('.nav-dropdown-trigger');

  function closeDropdown() {
    if (!dropdown) return;
    dropdown.removeAttribute('data-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
  }

  if (trigger) {
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = dropdown.hasAttribute('data-open');
      if (isOpen) {
        closeDropdown();
      } else {
        dropdown.setAttribute('data-open', '');
        trigger.setAttribute('aria-expanded', 'true');
      }
    });
  }

  document.addEventListener('click', function (e) {
    if (dropdown && !dropdown.contains(e.target)) closeDropdown();
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeDropdown();
      if (trigger) trigger.focus();
    }
  });

  // --- Hamburger ---
  var hamburger = document.querySelector('.nav-hamburger');
  var navLinks = document.getElementById('nav-links');

  if (hamburger && navLinks) {
    hamburger.addEventListener('click', function () {
      var isOpen = navLinks.classList.toggle('open');
      hamburger.setAttribute('aria-expanded', String(isOpen));
    });
  }

  // --- Section active state (index.html only) ---
  var scheduleSection = document.getElementById('schedule');
  var meetsSection = document.getElementById('meets');

  if (scheduleSection && meetsSection && 'IntersectionObserver' in window) {
    var homeLink = document.querySelector('.nav-links a[href="index.html"]');

    function setActive(selector) {
      document.querySelectorAll('.nav-links > a').forEach(function (a) {
        a.classList.remove('active');
      });
      var el = document.querySelector(selector);
      if (el) el.classList.add('active');
    }

    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          setActive('.nav-links a[href="index.html#' + entry.target.id + '"]');
        }
      });
    }, { rootMargin: '-60px 0px -55% 0px' });

    observer.observe(scheduleSection);
    observer.observe(meetsSection);
  }
})();
