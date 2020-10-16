'use strict';

/* global $:false, HSTSPreload:false, URLParam:false, PreloadView:false, extractDomain:false */

var Form = function(controller) {
  this._hstsPreload = new HSTSPreload();
  this._controller = new controller(this._hstsPreload);

  this._urlParam = new URLParam();
  this._view = new PreloadView(this._controller, this.submitDomain.bind(this), this._urlParam);

  var domainParam = this._urlParam.get();
  if (domainParam) {
    var domain = extractDomain(domainParam);

    if (domain === domainParam) {
      console.log('From URL parameter:', domain);
      $('#domain').value = domain;
      this.checkDomain(domain);
    } else {
      this._view.setDomain(domain);
      this._view.clickCheck();
    }
  }
};

Form.prototype = {
  checkDomain: function(domain) {
    this._view.clearDomainSpecificElements();
    this._view.showWaiting(domain);

    if (!domain) {
      console.log('checkDomain called with empty domain');
      $('#result-waiting').classList.add('hidden');
      return;
    }

    this._currentResultsDomain = '';

    Promise
      .all([
        this._hstsPreload.status(domain),
        this._controller.eligible(domain)
      ])
      .then(
        function(values) {
          this.handleResults(domain, values[0], values[1]);
        }.bind(this),
        function() {
          // TODO: handle failure better.
          $('#result').classList.remove('hidden');
          $('#result-waiting').classList.add('hidden');
        });
  },

  submitDomain: function() {
    var domain = this.domainToSubmit;

    this._controller.submit(domain).then(function(issues) {
      if (issues.errors.length === 0) {
        $('#submit-success').show();
        if ($('#ssl-labs-link')) {
          $('#ssl-labs-link')
            .href = 'https://www.ssllabs.com/ssltest/analyze.html?d=' + domain;
        }
      } else {
        this._view.setTheme('theme-red');
        $('#submit-failure').show();
        console.log(issues);
      }
    }.bind(this));
  },

  handleResults: function(domain, status, issues) {
    if (domain !== this._view.currentDomain()) {
      return;
    }
    if (this._currentResultsDomain === domain) {
      return;
    }
    this._currentResultsDomain = domain;

    if (domain !== this._view.currentDomain()) {
      console.log('Outdated result.');
      return;
    }


    this._view.clearStatus();
    this._view.clearSummary();
    var showForm = this._controller.showResults(this._view, domain, issues, status);
    this._view.hideWaiting();

    if (showForm) {
      this.domainToSubmit = domain;
      this._view.showSubmission(domain);
    }
  }
};

function statusString(status, issues, domain, isRemoval) {
  switch (status.status) {
    case 'unknown':
      return 'Status: ' + domain + ' is not preloaded.';
    case 'pending':
      return 'Status: ' + domain + ' is pending submission to the preload list.';
    case 'preloaded':
      if (status.bulk && !isRemoval) {
        switch (worstIssues(issues)) {
          case 'warnings':
            return 'Status: ' + domain + ' is currently preloaded, but has the following issues:';
          case 'errors':
            return 'Status: ' + domain + ' is currently preloaded, but no longer meets the requirements. It may be at risk of removal.';
          default:
            return 'Status: ' + domain + ' is currently preloaded.';
        }
      } else {
        return 'Status: ' + domain + ' is currently preloaded.';
      }
      break;

    case 'rejected':
      if (status.message) {
        return 'Status: ' + domain +
          ' was previously rejected from the preload list for the following reason: ' +
          status.message;
      }
      return 'Status: ' + domain +
          ' was previously rejected from the preload list.';

    case 'pending-removal':
      return 'Status: ' + domain +
          ' was previously submitted to the preload list, but is now pending removal.';
    case 'removed':
      return 'Status: ' + domain +
          ' was previously submitted to the preload list, but has been removed.';
    default:
      return 'Cannot determine preload status.';
  }
}

function worstIssues(issues) {
  if (issues.errors.length === 0) {
    if (issues.warnings.length === 0) {
      return 'none';
    }
    return 'warnings';

  }
  return 'errors';

}

var PreloadController = function(hstsPreload) {
  this._hstsPreload = hstsPreload;
};

PreloadController.prototype = {
  formHasCheckboxes: function() {
    return true;
  },

  eligible: function(domain) {
    return this._hstsPreload.preloadable(domain);
  },

  submit: function(domain) {
    return this._hstsPreload.submit(domain);
  },

  submitButtonString: function(domain) {
    return 'Submit ' + domain + ' to the HSTS preload list';
  },

  showPending: function(view, domain, issues) {
    switch (worstIssues(issues)) {
      case 'none':
        view.setStatus(
          'Status: ' + domain +
            ' is pending submission to the preload list.');
        view.setTheme('theme-green');
        break;
      case 'warnings':
        view.setStatus(
          'Status: ' + domain +
            ' is pending submission to the preload list.');
        view.setSummary(
          'However, it still has the following issues, which we recommend fixing:');
        view.setTheme('theme-yellow');
        view.showIssues(issues);
        break;
      case 'errors':
        view.setStatus(
          'Status: ' + domain +
            ' was recently submitted to the preload list.');
        view.setSummary(
          'However, ' + domain +
            ' has changed its behaviour since it was submitted, and will not be added to the official preload list unless the errors below are resolved:');
        view.setTheme('theme-red');
        view.showIssues(issues);
        break;
      default:
        throw new Error('Unknown Pending Status');
    }
  },

  showPreloadEligibility: function(view, domain, issues) {
    switch (worstIssues(issues)) {
      case 'none':
        view.setSummary(
          'Eligibility: ' + domain +
            ' is eligible for the HSTS preload list.');
        view.setTheme('theme-green');
        return true;
        break;
      case 'warnings':
        view.setSummary(
          'Eligibility: ' + domain +
            ' is eligible for preloading, although we recommend fixing the following warnings:');
        view.setTheme('theme-yellow');
        return true;
        break;
      case 'errors':
        view.setSummary(
          'Eligibility: In order for ' + domain +
            ' to be eligible for preloading, the errors below must be resolved:');
        view.setTheme('theme-red');
        return false;
        break;
      default:
        throw new Error('Unknown Preload Eligibility');
    }
  },

  showResults: function(view, domain, issues, status) {
    view.setStatus(statusString(status, issues, domain, false));

    var showForm = false;

    console.log('showResults', status);

    switch (status.status) {
      case 'unknown':
      case 'rejected':
      case 'removed':
      case 'pending-removal':
        showForm = this.showPreloadEligibility(view, domain, issues);
        view.showIssues(issues);
        break;
      case 'pending':
        this.showPending(view, domain, issues);
        break;
      case 'preloaded':
        view.setTheme('theme-green');
        if (status.bulk) {
          view.showIssues(issues);
          if (worstIssues(issues) !== 'none') {
            view.clearTheme();
          }
        }
        break;
      default:
        throw new Error('Unknown status');
    }

    view.showResults();
    return showForm;
  }
};


var RemovalController = function(hstsPreload) {
  this._hstsPreload = hstsPreload;
};

RemovalController.prototype = {
  formHasCheckboxes: function() {
    return false;
  },

  eligible: function(domain) {
    return this._hstsPreload.removable(domain);
  },

  submit: function(domain) {
    return this._hstsPreload.remove(domain);
  },

  submittableStatus: function(status) {
    return ['preloaded', 'pending'].indexOf(status) !== -1;
  },

  submitButtonString: function(domain) {
    return 'Remove ' + domain + ' from the HSTS preload list';
  },

  showRemovalEligibility: function(view, domain, issues) {
    switch (worstIssues(issues)) {
      case 'none':
        view.setSummary(
          'Eligibility: ' + domain +
            ' is eligible for removal from the HSTS preload list.');
        view.setTheme('theme-green');
        return true;
        break;
      case 'warnings':
        view.setSummary(
          'Eligibility: ' + domain +
            ' is eligible for removal, although we recommend fixing the following warnings:');
        view.setTheme('theme-yellow');
        return true;
        break;
      case 'errors':
        view.setSummary(
          'Eligibility: In order for ' + domain +
            ' to be eligible for removal from the preload list, the errors below must be resolved:');
        view.setTheme('theme-red');
        return false;
        break;
      default:
        throw new Error('Unknown Eligibility');
    }
  },

  showResults: function(view, domain, issues, status) {
    view.setStatus(statusString(status, issues, domain, true));

    var showForm = false;

    console.log('showResults', status);

    switch (status.status) {
      case 'unknown':
      case 'rejected':
      case 'removed':
      case 'pending-removal':
        view.setTheme('theme-red');
        break;
      case 'pending':
      case 'preloaded':
        showForm = this.showRemovalEligibility(view, domain, issues);
        view.showIssues(issues);
        break;
      default:
        throw new Error('Unknown status');
    }

    view.showResults();
    return showForm;
  }
};
