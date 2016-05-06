package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/chromium/hstspreload"
	"github.com/chromium/hstspreload/chromiumpreload"
)

func main() {
	staticHandler := http.FileServer(http.Dir("files"))
	http.Handle("/", staticHandler)
	http.Handle("/favicon.ico", staticHandler)
	http.Handle("/static/", staticHandler)

	http.HandleFunc("/robots.txt", http.NotFound)

	http.HandleFunc("/preloadable/", preloadable)
	http.HandleFunc("/removable/", removable)
	http.HandleFunc("/status/", status)
	http.HandleFunc("/submit/", submit)

	http.HandleFunc("/pending", pending)
	http.HandleFunc("/update", update)

	http.ListenAndServe(":8080", nil)
}

// writeJSONOrBust should only be called if nothing has been written yet.
func writeJSONOrBust(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-type", "text/css; charset=utf-8")

	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		msg := fmt.Sprintf("Internal error: could not format JSON. (%s)\n", err)
		http.Error(w, msg, http.StatusInternalServerError)
		return
	}

	fmt.Fprintf(w, "%s\n", b)
}

func preloadable(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Path[len("/preloadable/"):]

	_, issues := hstspreload.PreloadableDomain(domain)
	writeJSONOrBust(w, issues)
}

func removable(w http.ResponseWriter, r *http.Request) {
	domain := r.URL.Path[len("/removable/"):]

	_, issues := hstspreload.RemovableDomain(domain)
	writeJSONOrBust(w, issues)
}

func status(w http.ResponseWriter, r *http.Request) {
	domain := chromiumpreload.Domain(r.URL.Path[len("/status/"):])

	state, err := stateForDomain(domain)
	if err != nil {
		msg := fmt.Sprintf("Internal error: could not retrieve status. (%s)\n", err)
		http.Error(w, msg, http.StatusInternalServerError)
		return
	}

	state.Name = domain
	writeJSONOrBust(w, state)
}

func submit(w http.ResponseWriter, r *http.Request) {
	domainStr := r.URL.Path[len("/submit/"):]
	domain := chromiumpreload.Domain(domainStr)

	_, issues := hstspreload.PreloadableDomain(domainStr)
	if len(issues.Errors) > 0 {
		writeJSONOrBust(w, issues)
		return
	}

	state, stateErr := stateForDomain(domain)
	if stateErr != nil {
		msg := fmt.Sprintf("Internal error: could not get current domain status. (%s)\n", stateErr)
		http.Error(w, msg, http.StatusInternalServerError)
	}

	switch state.Status {
	case StatusUnknown:
		fallthrough
	case StatusRejected:
		fallthrough
	case StatusRemoved:
		putErr := putState(DomainState{
			Name:           domain,
			Status:         StatusPending,
			SubmissionDate: time.Now(),
		})
		if putErr != nil {
			issue := hstspreload.Issue{
				Code:    "internal.server.preload.save_failed",
				Summary: "Internal error",
				Message: "Unable to save to the pending list.",
			}
			issues = hstspreload.Issues{
				Errors:   append(issues.Errors, issue),
				Warnings: issues.Warnings,
			}
		}
	case StatusPending:
		formattedDate := state.SubmissionDate.Format("Monday, _2 January 2006")
		issue := hstspreload.Issue{
			Code:    "server.preload.already_pending",
			Summary: "Domain has already been submitted",
			Message: fmt.Sprintf("Domain is already pending. It was submitted on %s.", formattedDate),
		}
		issues = hstspreload.Issues{
			Errors:   issues.Errors,
			Warnings: append(issues.Warnings, issue),
		}
	case StatusPreloaded:
		issue := hstspreload.Issue{
			Code:    "server.preload.already_preloaded",
			Summary: "Domain is already preloaded",
			Message: "The domain is already preloaded.",
		}
		issues = hstspreload.Issues{
			Errors:   append(issues.Errors, issue),
			Warnings: issues.Warnings,
		}
	default:
		issue := hstspreload.Issue{
			Code:    "internal.server.preload.unknown_status",
			Summary: "Internal error",
			Message: "Cannot preload; could not find domain status.",
		}
		issues = hstspreload.Issues{
			Errors:   append(issues.Warnings, issue),
			Warnings: issues.Warnings,
		}
	}

	writeJSONOrBust(w, issues)
}

func pending(w http.ResponseWriter, r *http.Request) {
	names, err := domainsWithStatus(StatusPending)
	if err != nil {
		msg := fmt.Sprintf("Internal error: could not retrieve pending list. (%s)\n", err)
		http.Error(w, msg, http.StatusInternalServerError)
		return
	}

	fmt.Fprintf(w, "[\n")
	for i, name := range names {
		comma := ","
		if i+1 == len(names) {
			comma = ""
		}

		fmt.Fprintf(w, `    { "name": "%s", "include_subdomains": true, "mode": "force-https" }%s
`, name, comma)
	}
	fmt.Fprintf(w, "]\n")
}

func difference(from []chromiumpreload.Domain, take []chromiumpreload.Domain) (diff []chromiumpreload.Domain) {
	takeSet := make(map[chromiumpreload.Domain]bool)
	for _, elem := range take {
		takeSet[elem] = true
	}

	for _, elem := range from {
		if !takeSet[elem] {
			diff = append(diff, elem)
		}
	}

	return diff
}

func update(w http.ResponseWriter, r *http.Request) {
	// Get preload list.
	preloadList, listErr := chromiumpreload.GetLatest()
	if listErr != nil {
		msg := fmt.Sprintf(
			"Internal error: could not retrieve latest preload list. (%s)\n",
			listErr,
		)
		http.Error(w, msg, http.StatusInternalServerError)
		return
	}
	var actualPreload []chromiumpreload.Domain
	for _, entry := range preloadList.Entries {
		if entry.Mode == chromiumpreload.ForceHTTPS {
			actualPreload = append(actualPreload, entry.Name)
		}
	}

	// Get domains currently recorded as preloaded.
	databasePreload, dbErr := domainsWithStatus(StatusPreloaded)
	if dbErr != nil {
		msg := fmt.Sprintf(
			"Internal error: could not retrieve domain names previously marked as preloaded. (%s)\n",
			dbErr,
		)
		http.Error(w, msg, http.StatusInternalServerError)
		return
	}

	// Calculate values that are out of date.
	var updates []DomainState

	added := difference(actualPreload, databasePreload)
	for _, name := range added {
		updates = append(updates, DomainState{
			Name:   name,
			Status: StatusPreloaded,
		})
	}

	removed := difference(databasePreload, actualPreload)
	for _, name := range removed {
		updates = append(updates, DomainState{
			Name:   name,
			Status: StatusRemoved,
		})
	}

	fmt.Fprintf(w, `The preload list has %d entries.
- # of preloaded HSTS entries: %d
- # to be added in this update: %d
- # to be removed this update: %d
`,
		len(preloadList.Entries),
		len(actualPreload),
		len(added),
		len(removed),
	)

	// Create statusReport function to show progress.
	written := false
	f, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "Internal error: Could not create `http.Flusher`.\n", http.StatusInternalServerError)
		return
	}
	statusReport := func(format string, args ...interface{}) {
		fmt.Fprintf(w, format, args...)
		f.Flush()
		written = true
	}

	// Update the database
	putErr := putStates(updates, statusReport)
	if putErr != nil {
		msg := fmt.Sprintf(
			"Internal error: datastore update failed. (%s)\n",
			putErr,
		)
		if written {
			// The header and part of the body have already been sent, so we
			// can't change the status code anymore.
			fmt.Fprintf(w, msg)
		} else {
			http.Error(w, msg, http.StatusInternalServerError)
		}
		return
	}

	fmt.Fprintf(w, "Success. %d domain states updated.\n", len(updates))
}
